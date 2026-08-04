/**
 * The live `GraphDataSource` (Sync 2): `GET /api/snapshot` for a one-shot
 * read (`load`), `/ws` for everything after (`subscribe`), over the
 * documented resync recipe in `apps/server/src/routes/snapshot.ts`:
 *
 *   1. Connect to `/ws` first and buffer every event, unapplied.
 *   2. Fetch the snapshot. It carries `seq`.
 *   3. Drop buffered events with `seq <= snapshot.seq` (already reflected);
 *      apply the rest, in order.
 *
 * `subscribe` is the only method that runs this recipe — `load` is a plain,
 * point-in-time REST read with no event stream involved, so it has no
 * ordering-vs-events concern to begin with. A reconnect (the socket's own
 * backoff, or the connection simply dropping) redoes the whole recipe from
 * a fresh snapshot: the client never assumes a resumed connection picks up
 * where the old one left off.
 */

import type { DomainEvent } from "@plotroom/core";
import type { ProducedObject } from "@plotroom/plugin-sdk";

import type { CanvasCardView } from "../canvas/PlotCanvas.js";
import {
  createContributionRegistry,
  resolveCardView,
  type ContributionRegistry,
} from "../plugins/contribution-registry.js";
import type { HttpClient } from "../transport/http.js";
import type { WebSocketFactory } from "../transport/ws.js";
import { createReconnectingSocket } from "../transport/ws.js";
import type { BoardState } from "./board-state.js";
import {
  applyEvent,
  emptyBoardState,
  stateFromSnapshot,
} from "./board-state.js";
import type { RawSnapshot } from "./board-state.js";
import { buildGraphSnapshot } from "./build-snapshot.js";
import type { GraphDataSource, GraphSnapshot, Unsubscribe } from "./types.js";

/**
 * The `/ws` wire message shape, exported so any other data source scoped to
 * the same stream (`sessions/data-source.ts`'s live `SessionDataSource`)
 * parses it identically rather than restating the shape.
 */
export type WsServerMessage =
  | {
      readonly type: "hello";
      readonly nextSeq: number;
      readonly serverTime: number;
    }
  | { readonly type: "event"; readonly event: DomainEvent };

export function parseWsMessage(data: unknown): WsServerMessage | null {
  try {
    const text = typeof data === "string" ? data : String(data);
    const parsed = JSON.parse(text) as WsServerMessage;
    if (parsed.type === "hello" || parsed.type === "event") return parsed;
    return null;
  } catch {
    return null;
  }
}

/** Content nodes standing for a real (bound) object, wired as some command's context. */
function objectIdsNeedingContent(state: BoardState): readonly string[] {
  const contextSourceNodeIds = new Set(
    [...state.edges.values()]
      .filter((edge) => edge.kind === "context")
      .map((edge) => edge.from),
  );

  const ids = new Set<string>();
  for (const nodeId of contextSourceNodeIds) {
    const node = state.nodes.get(nodeId);
    if (!node || node.role !== "content") continue;
    // Skip pre-bind output placeholders: their refId names an output, not
    // an object, and there is no content to read yet.
    if (state.outputs.has(node.refId)) continue;
    if (state.objects.has(node.refId)) ids.add(node.refId);
  }
  return [...ids];
}

async function fetchObjectContent(
  http: HttpClient,
  state: BoardState,
): Promise<ReadonlyMap<string, string>> {
  const ids = objectIdsNeedingContent(state);
  const entries = await Promise.all(
    ids.map(async (id): Promise<readonly [string, string]> => {
      try {
        const response = await http.get<{
          content: { renderings: { agentContent: string } };
        }>(`/api/objects/${encodeURIComponent(id)}`);
        return [id, response.content.renderings.agentContent];
      } catch {
        // The object may have been removed since it was wired; an honest
        // empty string beats discarding the whole snapshot over one stale
        // reference.
        return [id, ""];
      }
    }),
  );
  return new Map(entries);
}

/**
 * A live object, as the plugin contract sees it (§10.1) — the client's own
 * `PlotObject` mapped onto `ProducedObject`. Core's `ObjectKind` mirrors the
 * frozen contract's `ConceptKind` exactly (same members, same spellings,
 * including `pull_request`), so `object.kind` needs no translation at this
 * boundary (`docs/plugin-contract.md` §7, deviation 13). An object without
 * an external identity (a native note, say) stands in for its own: nothing
 * downstream of a card renderer needs the two distinguished once the object
 * is already inside the client, and the alternative (refusing to resolve a
 * card for it) would make every locally-created object permanently
 * ineligible for a plugin's card renderer.
 */
function toProducedObject(
  object: BoardState["objects"] extends ReadonlyMap<string, infer O>
    ? O
    : never,
  agentContent: string,
): ProducedObject {
  return {
    kind: object.kind,
    externalId: object.external?.id ?? object.id,
    title: object.title,
    renderings: {
      card: object.title,
      summary: object.title,
      agentContent,
    },
  };
}

/**
 * Plugin card views for every live content node standing for a real object
 * (§10.1) — the async resolution `buildGraphSnapshot` itself never does
 * (its own doc comment: "every fact that needs IO ... resolved by the
 * caller first"). Empty immediately when nothing is registered (Batch 5
 * Stage 1's actual production state: `IN_BOX_PLUGIN_MODULES` is empty until
 * Filesystem lands), so this costs nothing until a plugin is.
 */
async function resolvePluginCardViews(
  state: BoardState,
  objectContent: ReadonlyMap<string, string>,
  registry: ContributionRegistry,
): Promise<ReadonlyMap<string, CanvasCardView>> {
  if (registry.listManifests().length === 0) return new Map();

  const contentNodes = [...state.nodes.values()].filter(
    (node) => node.role === "content",
  );
  const entries = await Promise.all(
    contentNodes.map(
      async (node): Promise<readonly [string, CanvasCardView] | null> => {
        const object = state.objects.get(node.refId);
        if (!object) return null;
        const produced = toProducedObject(
          object,
          objectContent.get(object.id) ?? "",
        );
        const view = await resolveCardView(registry, produced, "compact");
        return view ? [node.id, view] : null;
      },
    ),
  );
  return new Map(
    entries.filter(
      (entry): entry is readonly [string, CanvasCardView] => entry !== null,
    ),
  );
}

interface BufferState {
  buffering: boolean;
  events: DomainEvent[];
}

export interface ApiGraphDataSourceOptions {
  readonly http: HttpClient;
  readonly createSocket: WebSocketFactory;
  /**
   * The renderer contribution registry (§10.1) — defaults to an empty one,
   * so a caller that never passes one gets exactly today's behavior. Pass
   * `createInBoxContributionRegistry()` (`plugins/in-box-modules.ts`) once
   * an in-box plugin has a manifest to register.
   */
  readonly registry?: ContributionRegistry;
}

export function createApiGraphDataSource(
  options: ApiGraphDataSourceOptions,
): GraphDataSource {
  const { http, createSocket } = options;
  const registry = options.registry ?? createContributionRegistry();

  let state: BoardState = emptyBoardState();
  let started = false;
  let syncedOnce = false;
  let socket: ReturnType<typeof createReconnectingSocket> | null = null;
  // Reassigned on every (re)connect inside `ensureStarted`'s onStatusChange;
  // `onMessage` always routes through whichever buffer is current.
  let currentBuffer: BufferState | null = null;
  const listeners = new Set<(snapshot: GraphSnapshot) => void>();

  async function notifyAll(): Promise<void> {
    const content = await fetchObjectContent(http, state);
    const cardViews = await resolvePluginCardViews(state, content, registry);
    const snapshot = buildGraphSnapshot(state, content, cardViews);
    syncedOnce = true;
    for (const listener of listeners) listener(snapshot);
  }

  /** Step 2+3 of the recipe: fetch the snapshot, drop stale buffered events, apply the rest. */
  async function resync(buffer: BufferState): Promise<void> {
    const raw = await http.get<RawSnapshot>("/api/snapshot");
    // A newer (re)connect started its own resync while this one's fetch was
    // in flight — `currentBuffer` has already moved on to that one's buffer.
    // This resync lost the race: applying its (now stale) snapshot here
    // would stomp whatever the newer resync already settled, or will settle
    // once its own fetch lands. Bail without touching `state` at all.
    if (currentBuffer !== buffer) return;
    let next = stateFromSnapshot(raw);
    for (const event of buffer.events) {
      if (event.seq > raw.seq) next = applyEvent(next, event);
    }
    state = next;
    // Nothing awaits between draining the buffer and flipping this, so no
    // message arriving via the socket can land in the gap.
    buffer.buffering = false;
    buffer.events = [];
    await notifyAll();
  }

  function ensureStarted(): void {
    if (started) return;
    started = true;

    socket = createReconnectingSocket({
      createSocket,
      onStatusChange: (status) => {
        if (status !== "open") return;
        // Step 1: buffer from the moment the connection opens. Runs again,
        // unconditionally, on every reconnect — the whole recipe redone
        // from a fresh snapshot, never assuming continuity with whatever
        // came before.
        const buffer: BufferState = { buffering: true, events: [] };
        currentBuffer = buffer;
        void resync(buffer);
      },
      onMessage: (data) => {
        const message = parseWsMessage(data);
        if (!message || message.type !== "event" || !currentBuffer) return;
        if (currentBuffer.buffering) {
          currentBuffer.events.push(message.event);
        } else {
          state = applyEvent(state, message.event);
          void notifyAll();
        }
      },
    });
  }

  return {
    async load(): Promise<GraphSnapshot> {
      const raw = await http.get<RawSnapshot>("/api/snapshot");
      const freshState = stateFromSnapshot(raw);
      const content = await fetchObjectContent(http, freshState);
      const cardViews = await resolvePluginCardViews(
        freshState,
        content,
        registry,
      );
      return buildGraphSnapshot(freshState, content, cardViews);
    },

    /**
     * Re-fetch `/api/snapshot` into *this source's own* cached mirror (never
     * a caller's private copy the way `load()` is) and notify every
     * subscriber, exactly as if a `/ws` event had just arrived — the escape
     * hatch for the one write with nothing on the bus (`POST /api/reset`,
     * scope `"arrangement"`). Implemented as *the same* resync `reconnect`
     * runs, over a freshly minted buffer set as `currentBuffer` — never a
     * second, competing code path: minting the buffer first is what makes
     * this correct against a reconnect already resyncing when `refresh()`
     * is called — `resync`'s own "a newer buffer superseded mine" guard
     * then makes the older one a no-op once its fetch finally resolves,
     * exactly as it already does for two overlapping reconnects. A message
     * arriving on the socket while this fetch is in flight buffers into
     * *this* buffer for the same reason, and is applied after, in order.
     */
    async refresh(): Promise<void> {
      const buffer: BufferState = { buffering: true, events: [] };
      currentBuffer = buffer;
      await resync(buffer);
    },

    subscribe(onSnapshot: (snapshot: GraphSnapshot) => void): Unsubscribe {
      listeners.add(onSnapshot);
      if (syncedOnce) {
        // A later subscriber joining an already-synced source gets the
        // current picture immediately rather than waiting for the next
        // change.
        void fetchObjectContent(http, state).then(async (content) => {
          const cardViews = await resolvePluginCardViews(
            state,
            content,
            registry,
          );
          onSnapshot(buildGraphSnapshot(state, content, cardViews));
        });
      }
      ensureStarted();

      return () => {
        listeners.delete(onSnapshot);
        if (listeners.size === 0) {
          socket?.close();
          socket = null;
          started = false;
          syncedOnce = false;
          currentBuffer = null;
          state = emptyBoardState();
        }
      };
    },
  };
}
