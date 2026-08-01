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

type WsServerMessage =
  | {
      readonly type: "hello";
      readonly nextSeq: number;
      readonly serverTime: number;
    }
  | { readonly type: "event"; readonly event: DomainEvent };

function parseWsMessage(data: unknown): WsServerMessage | null {
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
        }>(`/api/objects/${id}`);
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

interface BufferState {
  buffering: boolean;
  events: DomainEvent[];
}

export interface ApiGraphDataSourceOptions {
  readonly http: HttpClient;
  readonly createSocket: WebSocketFactory;
}

export function createApiGraphDataSource(
  options: ApiGraphDataSourceOptions,
): GraphDataSource {
  const { http, createSocket } = options;

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
    const snapshot = buildGraphSnapshot(state, content);
    syncedOnce = true;
    for (const listener of listeners) listener(snapshot);
  }

  /** Step 2+3 of the recipe: fetch the snapshot, drop stale buffered events, apply the rest. */
  async function resync(buffer: BufferState): Promise<void> {
    const raw = await http.get<RawSnapshot>("/api/snapshot");
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
      return buildGraphSnapshot(freshState, content);
    },

    subscribe(onSnapshot: (snapshot: GraphSnapshot) => void): Unsubscribe {
      listeners.add(onSnapshot);
      if (syncedOnce) {
        // A later subscriber joining an already-synced source gets the
        // current picture immediately rather than waiting for the next
        // change.
        void fetchObjectContent(http, state).then((content) => {
          onSnapshot(buildGraphSnapshot(state, content));
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
