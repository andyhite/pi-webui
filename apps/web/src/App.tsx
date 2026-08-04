import { useEffect, useMemo, useRef, useState } from "react";
import { humanAuthor } from "@plotroom/core";
import type { SessionId, SessionPhase, Transcript } from "@plotroom/core";
import type {
  AppVerb,
  AttentionItem,
  BubbleSource,
  CommandPaletteItem,
  ContextInputRow,
  Collection,
  ContinueVsFreshView,
  GraphSnapshot,
  HandoffBriefView,
  KeyBinding,
  Note,
  OpenQuestion,
  Placements,
  SessionDetail,
} from "@plotroom/ui";
import {
  CommandPalette,
  ContextInputList,
  ConversationPanel,
  DiffPanel,
  DockRail,
  FleetPanel,
  GraphWarningsPanel,
  KeyBindingsProvider,
  LogsPanel,
  NotePanel,
  PaletteRail,
  PlotCanvas,
  QueuePanel,
  SearchPanel,
  SettingsPanel,
  ShortcutsOverlay,
  StopControls,
  TimelinePanel,
  WhatChangedPanel,
  attentionCount,
  beginRun,
  bindingKeysLabel,
  bindingsFromVerbs,
  browserWebSocketFactory,
  createApiActions,
  createApiActivityDataSource,
  createApiAttentionDataSource,
  createApiDiffDataSource,
  createApiFleetDataSource,
  createApiGraphDataSource,
  createApiLogsDataSource,
  createApiQuestionDataSource,
  createApiSearchDataSource,
  createApiSessionDataSource,
  createApiSettingsDataSource,
  createFixtureActivityDataSource,
  createFixtureAttentionDataSource,
  createEmptyPluginHealthDataSource,
  createFixtureDiffDataSource,
  createFixtureFleetDataSource,
  createFixtureGraphDataSource,
  createFixtureLogsDataSource,
  createFixturePluginHealthDataSource,
  createFixtureQuestionDataSource,
  createFixtureSearchDataSource,
  createFixtureSessionDataSource,
  createFixtureSettingsDataSource,
  createArrangementWriteQueue,
  createHttpClient,
  createInBoxContributionRegistry,
  createNote,
  createPanelRegistry,
  createUnavailableLifecycleActions,
  createWebStoragePlacementStore,
  createWebStorageSessionDraftsStore,
  localPlacementsToMigrate,
  reconcileAuthoredPlacements,
  commandPaletteItemsFromRegistry,
  commandPaletteItemsFromVerbs,
  decideNotification,
  definePanel,
  deriveBadgeCount,
  deriveCommandBubbleSources,
  deriveGraphWarnings,
  deriveInitialArrangement,
  deriveInjectionBubbleSources,
  deriveSessionBubbleSources,
  deriveWindowTitle,
  dragOutMember,
  EMPTY_NOTIFICATION_STATE,
  endRun,
  expandCollection,
  invokePluginPaletteEntry,
  nextNotificationEdgeState,
  panelDefinitionsFromRegistry,
  PluginHealthPanel,
  pruneMember,
  runAppVerb,
  useAttentionQueueCursor,
  useKeyBindingDispatch,
  useKeyBindings,
  useSelectionRoute,
} from "@plotroom/ui";
import type { InjectionLedgerEntry, WarningGraphNode } from "@plotroom/ui";

import {
  FIXTURE_ATTENTION_ITEMS,
  FIXTURE_COLLECTION,
  FIXTURE_FLEET_SUMMARY,
  FIXTURE_INJECTIONS,
  FIXTURE_LOGS,
  FIXTURE_OPEN_QUESTIONS,
  FIXTURE_PLUGIN_HEALTH,
  FIXTURE_RELEASED_CONTENT,
  FIXTURE_SEARCH_RESULTS,
  FIXTURE_SESSIONS,
  FIXTURE_SETTINGS,
  FIXTURE_WHAT_CHANGED,
  FIXTURE_SESSION_STATUSES,
  FIXTURE_SNAPSHOT,
  FIXTURE_TRANSCRIPT,
  FIXTURE_TRANSCRIPT_SCRIPT,
  FIXTURE_WORKSPACE_DIFF,
} from "./fixtures.js";

/**
 * Placement is durable across reloads (spec §5, §12). The server is the
 * source of truth in the live path now — every node's authored position
 * travels on the graph snapshot and every `node` event, and a drag persists
 * through `PATCH /api/nodes/:id/position` / `PATCH /api/arrangement` below
 * (Epic 3.1's deferral: "the renderer still writes to localStorage until it
 * adopts those endpoints" — closed). This store is kept for exactly two
 * things now, both deliberately *not* the live write path: fixture/offline
 * mode (`VITE_USE_FIXTURES=1`, where there is no server to author anything),
 * and reading whatever a pre-upgrade browser already saved here, once, to
 * migrate it onto the server rather than silently discarding an operator's
 * existing arrangement (`migrateLocalPlacements` below). The live path never
 * calls `.save()` on this — two writers of the same fact is exactly the
 * drift principle 8 exists to prevent.
 */
const localPlacementStore = createWebStoragePlacementStore(
  window.localStorage,
  "plotroom.placements.v1",
);

/**
 * The graph data seam (Epic 3.0, Sync 2): the canvas is fed by a
 * `GraphDataSource`, never by fixtures directly. Live by default; set
 * `VITE_USE_FIXTURES=1` for tests or offline dev — the fixture source
 * satisfies the exact same `GraphSnapshot` shape (`fixtures.ts`), so nothing
 * downstream of `subscribe()` cares which one is in play. Offline mode is
 * read-only: gestures that would mutate the board log why they didn't,
 * rather than silently doing nothing.
 */
const LIVE = import.meta.env.VITE_USE_FIXTURES !== "1";

const httpClient = createHttpClient((path, init) => fetch(path, init));
const wsFactory = browserWebSocketFactory();

/**
 * The renderer contribution registry (§10.1, Epic 7.1's renderer half): the
 * one client-side seam every in-box plugin registers a manifest through,
 * the same path a third-party plugin would use once dynamic loading exists
 * (`plugins/in-box-modules.ts` documents that gap). `IN_BOX_PLUGIN_MODULES`
 * now carries four in-box plugins — Filesystem, Coding/git, GitHub, and
 * Jira — each registering its own card/content/palette contributions
 * through the same seam a dynamically-loaded third-party plugin would use.
 */
const contributionRegistry = createInBoxContributionRegistry();

const graphDataSource = LIVE
  ? createApiGraphDataSource({
      http: httpClient,
      createSocket: wsFactory,
      registry: contributionRegistry,
    })
  : createFixtureGraphDataSource(FIXTURE_SNAPSHOT);

const actions = createApiActions(httpClient);

/**
 * Plugin health (§10.2, §11): gated on `LIVE` like every other seam in this
 * file. Contract v1 is frozen (`docs/plugin-contract.md`) and
 * `@plotroom/plugin-sdk`'s `PluginHost`/`PluginRegistry` are real — load,
 * invoke, enable/disable/remove, and a lifecycle event stream — but
 * `apps/server` mounts none of it yet (no `/api/plugins`, no published
 * events; §8's server wiring is Track A's), so in `LIVE` mode there is
 * nothing real to report — `createEmptyPluginHealthDataSource` resolves
 * zero entries and the panel's own "no plugins installed" state renders,
 * rather than the fixture rows being shown as if they were live data (an
 * honest absence, never a manufactured "connected" — `plugins/types.ts`).
 * Fixture mode keeps the fixture rows for tests/offline dev.
 * `createUnavailableLifecycleActions` is the honest stand-in for the verbs
 * either way: every call refuses with a stated reason rather than silently
 * succeeding.
 */
const pluginHealthDataSource = LIVE
  ? createEmptyPluginHealthDataSource()
  : createFixturePluginHealthDataSource(FIXTURE_PLUGIN_HEALTH);
const pluginLifecycleActions = createUnavailableLifecycleActions();

/**
 * The session data seam (Epic 5.1, Stage 2): live over Track A's run spine
 * (`GET /api/sessions(/:id, /transcript)` plus `/ws`) by default, the exact
 * same swap `createApiGraphDataSource` already does for the graph above;
 * fixture-fed for `VITE_USE_FIXTURES=1` (tests, offline dev).
 */
const sessionDataSource = LIVE
  ? createApiSessionDataSource({ http: httpClient, createSocket: wsFactory })
  : createFixtureSessionDataSource({
      sessions: FIXTURE_SESSIONS,
      statuses: FIXTURE_SESSION_STATUSES,
      transcripts: new Map([
        [FIXTURE_TRANSCRIPT.sessionId, FIXTURE_TRANSCRIPT],
      ]),
      script: FIXTURE_TRANSCRIPT_SCRIPT,
      releasedContent: FIXTURE_RELEASED_CONTENT,
    });

/**
 * Injection (§6.5): live over Track A's Stage 2 steering endpoints
 * (`POST /sessions/:id/inject`, now merged to main) — offline/fixture mode
 * still names why it cannot act, the same pattern `CHECKPOINT_DISABLED_
 * REASON` below already uses.
 */
const SEND_DISABLED_REASON = LIVE
  ? undefined
  : "offline mode: sending was not saved";

/**
 * The Diff panel's data seam (spec §11, Epic 5.1 finish): live over Track
 * A's `GET /api/workstreams/:id/diff` (now merged to main), addressed by
 * workstream id.
 */
const diffDataSource = LIVE
  ? createApiDiffDataSource({ http: httpClient })
  : createFixtureDiffDataSource(
      new Map([["workstream-oxy-2982", FIXTURE_WORKSPACE_DIFF]]),
    );

/**
 * Structured questions as bubbles (§6.4): live over Track A's Stage 2
 * steering endpoints (`GET /api/sessions`, `GET /sessions/:id/questions`,
 * `POST /questions/:id/answer`, the `session_question` `/ws` entity), now
 * merged to main.
 */
const questionDataSource = LIVE
  ? createApiQuestionDataSource({ http: httpClient, createSocket: wsFactory })
  : createFixtureQuestionDataSource(FIXTURE_OPEN_QUESTIONS);

/**
 * The transcript checkpoint gesture (§3.6, §6.1) has a real server endpoint
 * already (`POST /api/sessions/:id/checkpoint`) — live, not fixture-gated,
 * because unlike injection this one shipped with Track A's session routes.
 * Offline/fixture mode still names why it cannot act.
 */
const CHECKPOINT_DISABLED_REASON = LIVE
  ? undefined
  : "offline mode: checkpointing was not saved";

const now = () => Date.now();
/**
 * Bubble timestamps are epoch **seconds** throughout (`BubbleSource.
 * updatedAt`'s doc comment states the one-unit-throughout rule) — every
 * other source of a bubble timestamp already is (a transcript turn's
 * `startedAt`, an injection's `queuedAt`/`deliveredAt`, a question's
 * `raisedAt`), so this is the one place `now()`'s milliseconds get
 * converted before feeding the bubble derivation seam.
 */
const nowSeconds = () => Math.floor(now() / 1000);

/**
 * The attention data seam (Epic 6.1, §7, Stage 2): live over Track A's
 * derivation (`GET /api/attention` + the `attention` `/ws` entity,
 * `docs/attention-contract.md`) by default — the same swap every other
 * live seam in this file makes. `createFixtureAttentionDataSource` stays
 * for `VITE_USE_FIXTURES` (tests, offline dev), behind the identical
 * `AttentionDataSource` interface.
 */
const attentionDataSource = LIVE
  ? createApiAttentionDataSource({ http: httpClient, createSocket: wsFactory })
  : createFixtureAttentionDataSource(FIXTURE_ATTENTION_ITEMS, nowSeconds);

/**
 * The Fleet panel's data seam (§8, §11, Epic 6.2, Stage 2): live over
 * `GET /api/fleet` — the fleet aggregate endpoint that closed the
 * per-session-fan-out/no-concurrency-limit gap `fleet/types.ts` used to
 * record. Fixture-fed for `VITE_USE_FIXTURES`.
 */
const fleetDataSource = LIVE
  ? createApiFleetDataSource({ http: httpClient })
  : createFixtureFleetDataSource(FIXTURE_FLEET_SUMMARY);

/**
 * The what-changed-while-away seam (§7.3, Stage 2): live over
 * `GET /api/activity`, derived server-side from records that already
 * exist (a broadcast, a session that ended) — the server's own `cap` query
 * param trims per workstream, so there is no client-side capping left to
 * do. Fixture-fed for `VITE_USE_FIXTURES`.
 */
const activityDataSource = LIVE
  ? createApiActivityDataSource({ http: httpClient })
  : createFixtureActivityDataSource(FIXTURE_WHAT_CHANGED);

/**
 * The Search panel's data seam (§6.8, Epic 8.2): live over `GET /api/search`
 * (operator-only server-side; the browser's own calls are the human
 * operator by the actor header's default). Fixture-fed for
 * `VITE_USE_FIXTURES`.
 */
const searchDataSource = LIVE
  ? createApiSearchDataSource({ http: httpClient })
  : createFixtureSearchDataSource(FIXTURE_SEARCH_RESULTS);

/**
 * The Settings panel's data seam (§11, §8, Epic 8.3): live over
 * `GET`/`PUT`/`DELETE /api/settings(/:key)` plus the `setting` `/ws` entity.
 * Fixture-fed for `VITE_USE_FIXTURES`.
 */
const settingsDataSource = LIVE
  ? createApiSettingsDataSource({ http: httpClient, createSocket: wsFactory })
  : createFixtureSettingsDataSource(FIXTURE_SETTINGS);

/**
 * The Logs panel's data seam (§8, §11, Epic 8.3): live over `GET /api/logs`
 * plus the `log` `/ws` entity's drop notice. Fixture-fed for
 * `VITE_USE_FIXTURES`.
 */
const logsDataSource = LIVE
  ? createApiLogsDataSource({ http: httpClient, createSocket: wsFactory })
  : createFixtureLogsDataSource(FIXTURE_LOGS);

/** Drafts and prompt history persist per session (§6.2), the same durable-store seam as placement. */
const sessionDraftsStore = createWebStorageSessionDraftsStore(
  window.localStorage,
  "plotroom.session-drafts.v1",
);

/**
 * One binding registry for the whole app (§11, Epic 8.1): the provider is what
 * makes the surfaces that *register* bindings (the canvas, the palette, the
 * queue, this board's own verbs) and the surface that *lists* them (the
 * shortcuts overlay) see the same set — which is what makes "a binding cannot
 * exist undocumented" structural rather than a habit.
 */
export function App() {
  return (
    <KeyBindingsProvider>
      <Board />
    </KeyBindingsProvider>
  );
}

function Board() {
  const [placements, setPlacements] = useState<Placements | null>(null);
  // A one-shot bump for PlotCanvas's `arrangementEpoch` prop: writing fresh
  // `placements` alone never moves an already-mounted node (durable
  // placement means nothing may react to `placements` changing on its own,
  // spec §5) — "reset arrangement" also bumps this counter so the canvas
  // applies the fresh positions to nodes already on screen, exactly once.
  const [arrangementEpoch, setArrangementEpoch] = useState(0);
  /**
   * Durable placement, the write queue (§5, §12): every drag-stop and every
   * placed-with-a-position palette drop enqueues here rather than calling
   * the API directly, so a burst of quick gestures coalesces into one
   * request instead of several that could land out of order — "debounce
   * sensibly, never drop the final state." `actions` itself satisfies
   * `ArrangementWriter` (it has both methods the queue calls); created once
   * per mount, since `log` inside `onFailure` always forwards to the
   * *current* gesture log through `setGestureLog`'s stable functional
   * updater, however old the closure that captured it is.
   */
  const arrangementWriteQueueRef = useRef<ReturnType<
    typeof createArrangementWriteQueue
  > | null>(null);
  if (arrangementWriteQueueRef.current === null) {
    arrangementWriteQueueRef.current = createArrangementWriteQueue(actions, {
      onFailure: (result) => {
        log(
          `refused: saving the arrangement - ${
            result.refusal?.message ?? "the write did not go through"
          }`,
        );
      },
    });
  }
  const arrangementWriteQueue = arrangementWriteQueueRef.current;
  // Durable placement, the last chance to send it (§5, §12): a page torn
  // down for teardown (tab close, navigating away, mobile backgrounding)
  // must not lose a drag still sitting inside the debounce window —
  // `pagehide` fires reliably at exactly that moment (unlike `unload`, and
  // unlike `visibilitychange` for a bfcache-eligible navigation). Honestly
  // best-effort, not a guarantee: the underlying `fetch` calls
  // (`HttpClient`) are not `keepalive`-flagged, so a request the browser is
  // already tearing the page down around is not guaranteed to complete —
  // this still gives a pending write its best remaining chance rather than
  // none at all. Reads the ref directly (never the `arrangementWriteQueue`
  // variable) so the listener never needs to be re-registered; the queue
  // itself is created once and never changes after mount.
  useEffect(() => {
    function onPageHide(): void {
      void arrangementWriteQueueRef.current?.flush();
    }
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);
  // The run gesture's client-side guard (§4.1, principle 9 at the gesture
  // level): a command node id stays in this set for exactly as long as its
  // POST /api/runs is outstanding, so a double-click cannot mint a second
  // initiation key before the first request settles — see run-guard.ts.
  const [runsInFlight, setRunsInFlight] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // A run admitted but waiting under the concurrency limit (§4.1, Batch 3's
  // decision): "queued" is not a refusal, so it gets its own state rather
  // than folding into runsInFlight's binary "is a request outstanding".
  const [queuedRuns, setQueuedRuns] = useState<
    ReadonlyMap<
      string,
      { readonly queueEntryId: string; readonly position: number | null }
    >
  >(new Map());
  const { selectedNodeId, select } = useSelectionRoute();
  // The shortcuts overlay (§11), opened by its own registered binding below.
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // The app's single keydown listener (§11, Epic 8.1): every binding any
  // surface registered dispatches through here, scoped by what has focus.
  useKeyBindingDispatch();

  /**
   * The attention queue's cursor (§7.1, §11), held here rather than inside
   * `QueuePanel`: §11's queue verbs are keyboard verbs first — "move through
   * the queue, answer the selected item" — so they have to work whether or
   * not the panel is open, and a keypress and a click must be the same act on
   * the same selection.
   */
  const queueCursor = useAttentionQueueCursor({
    dataSource: attentionDataSource,
    onNavigate: select,
  });

  const [graph, setGraph] = useState<GraphSnapshot | null>(null);

  // A session node's id is the session's own id (its `refId`, `sessions/
  // canvas-node.ts`'s fixture helper and the live run path agree on this),
  // so the selected session for the Conversation panel is read straight off
  // the graph — live or fixture-fed alike, no separate lookup table needed.
  const selectedSessionId = useMemo(() => {
    if (!graph || !selectedNodeId) return null;
    const node = graph.nodes.find((n) => n.id === selectedNodeId);
    return node?.role === "session" ? (node.refId as SessionId) : null;
  }, [graph, selectedNodeId]);

  // The workstream the selected node lives inside, if any — a container's
  // own id *is* its workstream's id (`build-snapshot.ts` sets them equal),
  // so this is a plain lookup rather than a second id space. Both the Diff
  // panel and the stop controls read it: "a workstream's changes" and
  // "stop this workstream" are both about the same container.
  const selectedWorkstreamId = useMemo(() => {
    if (!graph || !selectedNodeId) return null;
    const node = graph.nodes.find((n) => n.id === selectedNodeId);
    return node?.containerId ?? null;
  }, [graph, selectedNodeId]);

  // What-changed's per-workstream section names (§7.3): a container's own
  // id is its workstream's id, so this is the same live graph the rest of
  // the app already reads — no separate fixture-vs-live name map needed.
  const workstreamNames = useMemo(
    () => new Map((graph?.containers ?? []).map((c) => [c.id, c.label])),
    [graph],
  );

  const [collapsedContainerIds, setCollapsedContainerIds] = useState<
    Set<string>
  >(() => new Set());

  // Handoff briefs (§6.3, Batch 3 carry-over), keyed by their source
  // session so several sessions' briefs never collide in one bag.
  const [handoffBriefsBySession, setHandoffBriefsBySession] = useState<
    ReadonlyMap<string, readonly HandoffBriefView[]>
  >(new Map());

  function refreshHandoffBriefs(sessionId: string): void {
    void actions.listHandoffBriefs(sessionId).then((response) => {
      setHandoffBriefsBySession((current) =>
        new Map(current).set(sessionId, response.briefs),
      );
    });
  }

  // Continue-vs-fresh (§4.3, Batch 3 carry-over): re-fetched whenever the
  // selected session's own record says it ended and names a command — a
  // second, lightweight `subscribeSession` just for `commandId`/`end`,
  // since `ConversationPanel` keeps its own detail state privately.
  const [selectedSessionDetail, setSelectedSessionDetail] =
    useState<SessionDetail | null>(null);
  useEffect(() => {
    setSelectedSessionDetail(null);
    if (!selectedSessionId) return;
    return sessionDataSource.subscribeSession(
      selectedSessionId,
      setSelectedSessionDetail,
    );
  }, [selectedSessionId]);

  const [continuationPreview, setContinuationPreview] =
    useState<ContinueVsFreshView | null>(null);
  useEffect(() => {
    setContinuationPreview(null);
    const commandId = selectedSessionDetail?.session.commandId;
    if (!commandId || selectedSessionDetail?.session.end === null) return;
    let cancelled = false;
    void actions.getContinuation(commandId).then((result) => {
      if (!cancelled) setContinuationPreview(result);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedSessionDetail]);

  const initialNote = useMemo(
    () =>
      createNote(
        "note-steering",
        "Remember: this repo uses pnpm, never npm.",
        humanAuthor,
        now(),
      ),
    [],
  );

  // §3.1: a collection expands, prunes, and drags members out. There is no
  // collection membership model server-side yet (an open decision, per
  // docs/AGENTS.md), so this stays a fixture-shaped demo either way.
  const [collection, setCollection] = useState<Collection>(() => ({
    ...FIXTURE_COLLECTION,
    expanded: false,
  }));

  const [gestureLog, setGestureLog] = useState<readonly string[]>([]);
  function log(entry: string): void {
    setGestureLog((current) => [...current, entry]);
  }

  // Durable placement, the live path (§5, §12): the graph snapshot already
  // carries every node's authored position, so `placements` is seeded and
  // reconciled from it (`reconcileAuthoredPlacements`) rather than a
  // separate load below. Fixture/offline mode has no server to author
  // anything, so it still reads `localPlacementStore` once at mount, the
  // same as before. Kept live so drag-stop can diff against it without
  // depending on the `placements` state directly (which would re-fire this
  // effect on every drag).
  const placementsRef = useRef<Placements | null>(null);
  placementsRef.current = placements;
  // Guards the local→server migration (`localPlacementsToMigrate`) to fire
  // at most once per mount, regardless of how many snapshots arrive while
  // its own async push is still in flight.
  const migrationAttempted = useRef(false);

  useEffect(() => {
    let cancelled = false;
    if (!LIVE) {
      void localPlacementStore.load().then((loaded) => {
        if (!cancelled) setPlacements(loaded);
      });
    }
    const unsubscribe = graphDataSource.subscribe((snapshot) => {
      if (!cancelled) setGraph(snapshot);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Durable placement, reconciled (§5, §12): every snapshot — not only a
  // placement one — carries every node's authored position, so this folds
  // it into `placements` every time `graph` changes. The very first
  // application (this mount's first snapshot) always applies, even when
  // there is nothing to reconcile yet, because that is what flips
  // `placements` from `null` to `{}` and unblocks the canvas's first
  // render; every application after that only touches state and bumps
  // `arrangementEpoch` when something genuinely changed — this same
  // client's own optimistic write, echoed back, changes nothing and moves
  // nothing on screen a second time.
  useEffect(() => {
    if (!LIVE || !graph) return;

    const authoredCount = [...graph.positions.values()].filter(
      (position) => position !== null,
    ).length;

    if (!migrationAttempted.current) {
      migrationAttempted.current = true;
      // One-time migration off the pre-upgrade client-only store (Epic 3.1's
      // deferral, closed): a browser already holding positions here,
      // against a server that has authored none yet, is an operator's
      // existing arrangement about to be silently discarded if nothing
      // pushes it across — principle 12 forbids that. Pushed once, as a
      // batch, then the local copy is cleared so nothing dual-writes
      // afterward; a refusal is surfaced (never silently dropped) and the
      // local copy is deliberately left in place so a retry on the next
      // load can still find it.
      const liveNodeIds = new Set(graph.nodes.map((node) => node.id));
      void localPlacementStore.load().then(async (local) => {
        const toMigrate = localPlacementsToMigrate(
          local,
          authoredCount,
          liveNodeIds,
        );
        if (!toMigrate) return;
        const entries = Object.entries(toMigrate).map(([nodeId, position]) => ({
          nodeId,
          position,
        }));
        try {
          const result = await actions.setArrangement(entries);
          if (!result.ok) {
            log(
              `refused: migrating ${entries.length} locally-stored position(s) to the server - ${result.refusal.message}`,
            );
            return;
          }
          window.localStorage.removeItem("plotroom.placements.v1");
          log(
            `migrated ${entries.length} locally-stored position(s) to the server`,
          );
        } catch (err) {
          // A *thrown* write (a network failure, a 5xx) must surface exactly
          // like a refusal does, never vanish into an unhandled rejection —
          // the local copy already stays in place either way, so the next
          // load can still retry.
          log(
            `failed to migrate ${entries.length} locally-stored position(s) to the server: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      });
    }

    const before = placementsRef.current;
    const isFirstApplication = before === null;
    const { placements: next, changed } = reconcileAuthoredPlacements(
      before ?? {},
      graph.positions,
    );
    if (!isFirstApplication && !changed) return;
    setPlacements(next);
    if (!isFirstApplication) setArrangementEpoch((epoch) => epoch + 1);
  }, [graph]);

  // "One derivation, many surfaces" (§7): every attention-facing render
  // below — off-screen markers, node badges, header count, window title,
  // app badge, system notification — reads this one subscription.
  const [attentionItems, setAttentionItems] = useState<
    readonly AttentionItem[]
  >([]);

  useEffect(() => {
    return attentionDataSource.subscribe(setAttentionItems);
  }, []);

  const attentionNodeIds = useMemo<readonly string[]>(
    () => [...new Set(attentionItems.map((item) => item.target.nodeId))],
    [attentionItems],
  );

  // Node state (§7): unifies with `warningsByNodeId`'s own badge mechanism
  // (`PlotCanvas.tsx`) — one badge per node, naming the count and the
  // highest-ranked feed wanting attention on it.
  const attentionByNodeId = useMemo(() => {
    const map = new Map<string, { count: number; topFeed: string }>();
    for (const item of attentionItems) {
      const existing = map.get(item.target.nodeId);
      if (!existing) {
        map.set(item.target.nodeId, { count: 1, topFeed: item.feed });
      } else {
        map.set(item.target.nodeId, {
          count: existing.count + 1,
          topFeed: existing.topFeed,
        });
      }
    }
    return map;
  }, [attentionItems]);

  // Header indicator, window title, app badge (§7): three renderings of the
  // exact same count, derived every time the feed changes.
  const attentionTotal = attentionCount(attentionItems);

  useEffect(() => {
    document.title = deriveWindowTitle("PlotRoom", attentionTotal);
  }, [attentionTotal]);

  useEffect(() => {
    // Electron only (`apps/desktop/src/preload.ts`); a no-op in a plain
    // browser tab, which is the whole point of feature-detecting it here
    // rather than assuming the bridge exists (§12: one renderer, two hosts).
    window.plotroom?.setBadgeCount(deriveBadgeCount(attentionTotal));
  }, [attentionTotal]);

  // System notification (§7.3): edge-triggered — only fires for items never
  // seen before, batched into one call per change. The state ref survives
  // across renders without re-subscribing to anything.
  const notificationState = useRef(EMPTY_NOTIFICATION_STATE);
  useEffect(() => {
    const notification = decideNotification(
      attentionItems,
      notificationState.current,
    );
    notificationState.current = nextNotificationEdgeState(
      notificationState.current,
      attentionItems,
    );
    if (!notification) return;
    // Electron's renderer grants this without the browser's permission
    // prompt (§7.3's "renderer permission-less path"); a plain browser tab
    // still has `Notification` but would prompt — feature-detected either
    // way so offline/test environments without it never throw.
    if (typeof Notification !== "undefined") {
      new Notification(notification.title, { body: notification.body });
    }
  }, [attentionItems]);

  // Speech bubbles (§5): session sayings/tool-in-flight and the injection
  // ledger are fed live off the same `SessionDataSource` the Conversation
  // panel already uses — one subscription per session-role node currently
  // on the graph, kept live exactly the way `subscribeSession`/
  // `subscribeTranscript`/`subscribeInjections` already are elsewhere.
  // Structured questions have their own live source (`questionDataSource`
  // above); offline/fixture mode falls back to `FIXTURE_INJECTIONS`, since
  // there is no live ledger to subscribe to without a server.
  //
  // A bubble attaches to a *canvas node* id (`node.id`), never a session id
  // (`node.refId`) — the two coincide for every fixture (`sessionCanvasNode`
  // sets both to the session's own id), which is exactly what let this seam
  // subscribe under the wrong id for a whole window without a single test
  // catching it: every fixture and unit test satisfied `nodeId === sessionId`
  // by construction, and only a real server (a real node id, generated
  // separately from the session id it stands for) disagreed. `sessionNodeIds`
  // is deliberately `{ nodeId, sessionId }` pairs, not one list read two ways,
  // so the two id spaces cannot be silently reconflated again at a call site.
  const sessionNodeIds = useMemo(
    () =>
      (graph?.nodes ?? [])
        .filter((n) => n.role === "session" && n.refId)
        .map((n) => ({ nodeId: n.id, sessionId: n.refId as SessionId })),
    [graph],
  );
  // The same pairing, the other direction — structured questions (below)
  // arrive keyed by session id and need the node id to attach a bubble to.
  const nodeIdBySessionId = useMemo(
    () =>
      new Map(
        sessionNodeIds.map(({ nodeId, sessionId }) => [sessionId, nodeId]),
      ),
    [sessionNodeIds],
  );
  const [sessionBubbleData, setSessionBubbleData] = useState<
    ReadonlyMap<
      string,
      {
        transcript: Transcript;
        phase: SessionPhase;
        injections: readonly InjectionLedgerEntry[];
      }
    >
  >(new Map());

  useEffect(() => {
    const unsubscribes = sessionNodeIds.map(({ nodeId, sessionId }) => {
      let transcript: Transcript = { sessionId, turns: [] };
      let phase: SessionPhase = { kind: "idle" };
      let injections: readonly InjectionLedgerEntry[] = [];
      function apply(): void {
        setSessionBubbleData((current) => {
          const next = new Map(current);
          next.set(nodeId, { transcript, phase, injections });
          return next;
        });
      }
      const unsubscribeTranscript = sessionDataSource.subscribeTranscript(
        sessionId,
        (event) => {
          transcript = event.transcript;
          apply();
        },
      );
      const unsubscribeSession = sessionDataSource.subscribeSession(
        sessionId,
        (detail) => {
          phase = detail.status.phase;
          apply();
        },
      );
      const unsubscribeInjections = sessionDataSource.subscribeInjections(
        sessionId,
        (event) => {
          injections = event.injections;
          apply();
        },
      );
      return () => {
        unsubscribeTranscript();
        unsubscribeSession();
        unsubscribeInjections();
      };
    });
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [sessionNodeIds]);

  const [openQuestions, setOpenQuestions] = useState<readonly OpenQuestion[]>(
    [],
  );
  useEffect(
    () => questionDataSource.subscribe((open) => setOpenQuestions(open)),
    [],
  );

  const bubbleSources = useMemo<readonly BubbleSource[]>(() => {
    if (!graph) return [];
    const commandInputs = graph.nodes
      .filter((n) => n.role === "command")
      .map((n) => ({
        nodeId: n.id,
        assembledContent: graph.warningFacts.get(n.id)?.assembledContent ?? "",
        // No per-command "context last changed" timestamp exists in
        // WarningFacts yet, so the honest value is "now" (seconds), not a
        // literal 0 — 0 would permanently lose every recency tie-break
        // against any session bubble under global-cap pressure.
        updatedAt: nowSeconds(),
      }));
    const commandSources = deriveCommandBubbleSources(commandInputs);

    const sessionSources = sessionNodeIds.flatMap(({ nodeId }) => {
      const data = sessionBubbleData.get(nodeId);
      if (!data) return [];
      return deriveSessionBubbleSources({
        nodeId,
        transcript: data.transcript,
        phase: data.phase,
        nowSeconds: nowSeconds(),
      });
    });

    // Live (§6.5): each session node's own ledger, off the same
    // subscription that feeds sessionSources above. Offline/fixture mode
    // has no live ledger to read, so it falls back to the fixture one,
    // rendered on whichever session node(s) it names.
    const injectionSources = LIVE
      ? sessionNodeIds.flatMap(({ nodeId }) => {
          const data = sessionBubbleData.get(nodeId);
          if (!data || data.injections.length === 0) return [];
          return deriveInjectionBubbleSources(
            nodeId,
            new Map(data.injections.map((entry) => [entry.id, entry])),
          );
        })
      : sessionNodeIds.flatMap(({ nodeId }) => {
          const injectedNodeIds = new Set(
            [...FIXTURE_INJECTIONS.values()].map(
              (entry) => entry.nodeId as string,
            ),
          );
          return injectedNodeIds.has(nodeId)
            ? deriveInjectionBubbleSources(nodeId, FIXTURE_INJECTIONS)
            : [];
        });

    // `OpenQuestion.nodeId` is the *session* id on the live source
    // (`createApiQuestionDataSource`'s `toOpenQuestion` has only a
    // `SessionQuestion` to read, which knows no canvas node) and the fixture's
    // own node id on the fixture source (where the two already coincide) —
    // `nodeIdBySessionId` resolves either uniformly, falling back to the raw
    // value so an unresolvable id collapses into `UNATTACHED_BUBBLE_NODE_ID`
    // (placement.ts) rather than silently vanishing.
    const questionSources: BubbleSource[] = openQuestions.map((question) => {
      const attachedNodeId =
        nodeIdBySessionId.get(question.nodeId as SessionId) ?? question.nodeId;
      return {
        id: `${attachedNodeId}:question:${question.id}`,
        nodeId: attachedNodeId,
        kind: "question",
        text: question.text,
        options: question.options,
        answeredValue: question.answeredValue,
        updatedAt: question.raisedAt,
        wantsAttention: question.answeredValue === null,
      };
    });

    return [
      ...commandSources,
      ...sessionSources,
      ...injectionSources,
      ...questionSources,
    ];
  }, [
    graph,
    sessionNodeIds,
    sessionBubbleData,
    openQuestions,
    nodeIdBySessionId,
  ]);

  // Graph warnings (§5): pure derivation over the live graph, re-run
  // whenever it changes. Never a refusal — read here and in the editor
  // surface (the Warnings panel) below.
  const warnings = useMemo(() => {
    if (!graph) return [];
    const warningNodes: WarningGraphNode[] = graph.nodes.map((node) => ({
      id: node.id,
      role: node.role,
      ...graph.warningFacts.get(node.id),
    }));
    return deriveGraphWarnings(
      warningNodes,
      graph.edges.map((edge) => ({ from: edge.source, to: edge.target })),
    );
  }, [graph]);

  const warningsByNodeId = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const warning of warnings) {
      const existing = map.get(warning.nodeId) ?? [];
      existing.push(warning.message);
      map.set(warning.nodeId, existing);
    }
    return map;
  }, [warnings]);

  /**
   * The run gesture (§4.1), as one function: the canvas's run button, the
   * `R` binding, and the palette's own row all call *this* — never three
   * paths that agree by coincidence (principle 8, one vocabulary).
   */
  function runCommandNode(commandNodeId: string): void {
    if (!LIVE) {
      log(`offline mode: running ${commandNodeId} was not started`);
      return;
    }
    // The gesture-level guard (§4.1, principle 9): a double-click — or a held
    // `R` — before the first request settles must not mint a second
    // initiation key. Checked and applied via one state update, so two
    // gestures handled in the same tick cannot both read "not yet in flight".
    let guardedIn = false;
    setRunsInFlight((current) => {
      const guard = beginRun(current, commandNodeId);
      guardedIn = guard.allowed;
      return guard.inFlight;
    });
    if (!guardedIn) {
      log(
        `run already in flight for ${commandNodeId}; ignoring the extra gesture`,
      );
      return;
    }

    const commandNode = graph?.nodes.find((node) => node.id === commandNodeId);
    if (!commandNode?.refId) {
      setRunsInFlight((current) => endRun(current, commandNodeId));
      return;
    }
    // The client's own idea of "this gesture" (principle 9): a retry with the
    // same key would get the same run and session back, never a second one —
    // a fresh key per gesture is exactly one run per gesture.
    const initiationKey = `run-${crypto.randomUUID()}`;
    void actions
      .runCommand({ commandId: commandNode.refId, initiationKey })
      .then((result) => {
        setRunsInFlight((current) => endRun(current, commandNodeId));
        if (!result.ok) {
          log(`refused: ${result.refusal.reason} - ${result.refusal.message}`);
          return;
        }
        const outcome = result.value;
        if (outcome.kind === "queued") {
          setQueuedRuns((current) => {
            const next = new Map(current);
            next.set(commandNodeId, {
              queueEntryId: outcome.queueEntryId,
              position: outcome.position,
            });
            return next;
          });
          log(
            `run for ${commandNodeId} queued at position ${outcome.position ?? "?"} (concurrency limit reached)`,
          );
          return;
        }
        log(`run ${outcome.runId} started; session ${outcome.sessionId}`);
      });
  }

  /**
   * Placing a palette entry (§5), for the pointer and the keyboard alike: a
   * drop supplies the position it landed on, and a keyboard activation
   * supplies none — in which case the node gets no stored placement at all and
   * the canvas's own derived initial arrangement puts it somewhere sensible
   * (§5: "an initial arrangement is derived"). Same action, same refusal
   * channel, one function (principle 8).
   */
  function placePaletteEntry(
    entryId: string,
    position?: { readonly x: number; readonly y: number },
  ): void {
    if (!LIVE) {
      log(`offline mode: placing ${entryId} was not saved`);
      return;
    }
    const entry = graph?.paletteEntries.find((e) => e.id === entryId);
    if (!entry || entry.kind === "command_definition") return;
    const role = entry.kind === "session" ? "session" : "content";
    void actions
      .placeNode({
        role,
        refId: entryId,
        ...(role === "session" ? { running: false } : {}),
      })
      .then((result) => {
        if (!result.ok) {
          log(`refused: ${result.refusal.reason} - ${result.refusal.message}`);
          return;
        }
        log(`placed ${entryId} as node ${result.value.nodeId}`);
        if (position === undefined) return;
        // Durable placement, one node (§5, §12): the server is the only place
        // this lands now — optimistic locally so the drop shows up where it
        // landed immediately, enqueued through the same write queue a drag
        // uses so a drop right after a drag still coalesces sensibly.
        setPlacements((current) => ({
          ...current,
          [result.value.nodeId]: position,
        }));
        arrangementWriteQueue.enqueue({ [result.value.nodeId]: position });
      });
  }

  /** §5's only automatic-layout verb: re-derive every position from structure. */
  function resetArrangement(): void {
    if (!graph) return;

    if (!LIVE) {
      // Fixture/offline mode has no server to clear; re-derive and save
      // locally, exactly as before.
      const next = deriveInitialArrangement(
        graph.nodes.map((node) => ({
          id: node.id,
          ...(node.containerId ? { containerId: node.containerId } : {}),
        })),
        graph.edges.map((edge) => ({
          source: edge.source,
          target: edge.target,
        })),
        graph.containers.map((container) => ({ id: container.id })),
      );
      setPlacements(next);
      void localPlacementStore.save(next);
      setArrangementEpoch((epoch) => epoch + 1);
      log("reset arrangement: re-derived from graph structure");
      return;
    }

    // Durable, server-side (§5, §12): `POST /api/reset` (scope
    // `"arrangement"`) clears every authored position — the operator's own
    // click is the confirmation. That endpoint publishes nothing on `/ws`
    // (`apps/server/src/maintenance/reset.ts`), so `refresh()` forces a
    // fresh `/api/snapshot` read; the reconcile effect below then folds the
    // now-null positions into `placements` and bumps `arrangementEpoch`
    // itself — one path for "authored positions changed", never a second
    // one duplicated here.
    void actions
      .resetArrangement()
      .then((result) => {
        if (!result.ok) {
          log(`refused: reset arrangement - ${result.refusal.message}`);
          return;
        }
        void graphDataSource
          .refresh?.()
          .then(() => {
            log(
              `reset arrangement: cleared ${result.value.arrangedNodesCleared} authored position(s); re-derived from graph structure`,
            );
          })
          .catch((err) => {
            // The server-side clear already succeeded; only the local
            // re-read failed. Still surfaced — the operator's canvas may
            // now disagree with the server until the next snapshot event.
            log(
              `reset arrangement: cleared ${result.value.arrangedNodesCleared} authored position(s) on the server, but re-reading the fresh snapshot failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
      })
      .catch((err) => {
        // A *thrown* reset (network failure, a 5xx) must surface exactly
        // like a refusal does, never vanish into an unhandled rejection.
        log(
          `failed to reset arrangement: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
  }

  /**
   * Stop the selected session (§6.7), the one scope that needs no
   * confirmation. The same `stopScope` action the Stop panel's buttons call,
   * riding the same refusal channel — a keyboard stop is not a second stop.
   */
  function stopSelectedSession(): void {
    if (!selectedSessionId) {
      log("nothing to stop: no session is selected");
      return;
    }
    void actions
      .stopScope({ scope: "session", sessionId: selectedSessionId })
      .then((result) => {
        if (!result.ok) {
          log(`refused to stop (session): ${result.refusal.message}`);
          return;
        }
        log(
          `stopped (session): ${
            result.value.stoppedSessionIds.length
              ? result.value.stoppedSessionIds.join(", ")
              : "nothing was running"
          }`,
        );
      });
  }

  /**
   * The high-frequency verbs (§11), declared **once**: each becomes a
   * registry binding (and so a row in the shortcuts overlay) and a command
   * palette row, from this one definition. Every `run` below is the same
   * action the mouse path calls — the keyboard is a second way to ask, never
   * a second implementation.
   */
  const verbs = useMemo<readonly AppVerb[]>(
    () => [
      {
        id: "verb-queue-next",
        label: "move to the next attention item",
        description:
          "moves the queue's highlight down, whether or not the Queue panel is open",
        chords: [{ key: "j" }],
        run: () => queueCursor.move("next"),
      },
      {
        id: "verb-queue-prev",
        label: "move to the previous attention item",
        description: "moves the queue's highlight up",
        chords: [{ key: "k" }],
        run: () => queueCursor.move("prev"),
      },
      {
        id: "verb-queue-answer-option",
        label: "answer the selected item with its Nth option",
        description:
          "answers the highlighted question with option 1–9 (§6.4); the answer returns to the session as a result",
        chords: Array.from({ length: 9 }, (_unused, index) => ({
          key: String(index + 1),
        })),
        keysLabel: "1–9",
        run: (chord) => {
          const index = Number(chord?.key ?? "") - 1;
          if (!Number.isInteger(index)) return;
          if (!queueCursor.answerOption(index)) {
            log("nothing answered: the selected item has no such option");
          }
        },
      },
      {
        id: "verb-queue-approve",
        label: "approve the selected item",
        description: "approves the highlighted approval once (§6.6)",
        chords: [{ key: "a" }],
        run: () => {
          if (!queueCursor.approve()) {
            log("nothing approved: the selected item is not an approval");
          }
        },
      },
      {
        id: "verb-queue-acknowledge",
        label: "acknowledge the selected item",
        description:
          "clears the highlighted row from the queue without answering anything (§4.5)",
        chords: [{ key: "e" }],
        run: () => {
          if (!queueCursor.acknowledge()) log("nothing to acknowledge");
        },
      },
      {
        id: "verb-queue-snooze",
        label: "snooze the selected item",
        description: "brings the highlighted row back in an hour (§4.5)",
        run: () => {
          if (!queueCursor.snooze()) log("nothing to snooze");
        },
      },
      {
        id: "verb-queue-mute",
        label: "mute the selected item",
        description: "stops the highlighted row from returning at all (§4.5)",
        run: () => {
          if (!queueCursor.mute()) log("nothing to mute");
        },
      },
      {
        id: "verb-queue-deny",
        label: "deny the selected approval",
        description:
          "denies with the reason typed in that row; a bare refusal is refused (§6.6)",
        chords: [{ key: "d" }],
        scope: "queue",
        run: () => {
          if (!queueCursor.denySelected()) {
            log(
              "nothing denied: a deny needs a reason typed in its row (§6.6)",
            );
          }
        },
      },
      {
        id: "verb-queue-navigate",
        label: "go to the selected attention item",
        description:
          "moves the canvas to the highlighted row's node — the queue is a lens, not a place (§7.1)",
        chords: [{ key: "Enter" }],
        scope: "queue",
        run: () => queueCursor.navigate(),
      },
      {
        id: "verb-run-selected-node",
        label: "run the selected node",
        description:
          "runs the selected command node — the same gesture as its run button (§4.1)",
        chords: [{ key: "r" }],
        run: () => {
          const node = graph?.nodes.find(
            (candidate) => candidate.id === selectedNodeId,
          );
          if (!node || node.role !== "command") {
            log("nothing to run: the selected node is not a command");
            return;
          }
          runCommandNode(node.id);
        },
      },
      {
        id: "verb-stop-selected-session",
        label: "stop the selected session",
        description:
          "stops the selected session — the narrowest of §6.7's three scopes",
        chords: [{ key: "s" }],
        run: () => stopSelectedSession(),
      },
      {
        id: "verb-shortcuts-overlay",
        label: "show keyboard shortcuts",
        description:
          "lists every registered binding — no binding exists undocumented (§11)",
        chords: [{ key: "?" }],
        run: () => setShortcutsOpen(true),
      },
      {
        id: "verb-reset-arrangement",
        label: "reset arrangement",
        description:
          "re-derives every node's position from the graph's structure (§5)",
        run: () => resetArrangement(),
      },
      {
        id: "verb-clear-log",
        label: "clear gesture log",
        description: "empties this page's log of gestures and refusals",
        run: () => setGestureLog([]),
      },
    ],
    // The verb closures read exactly these: the graph, what is selected, and
    // the queue's cursor. The helpers they call (`runCommandNode`,
    // `stopSelectedSession`, `resetArrangement`) are re-created every render
    // over the same values, so this list is what decides when a binding is
    // re-registered with a fresher closure.
    [graph, selectedNodeId, selectedSessionId, queueCursor],
  );

  // The bindings these verbs back, registered for as long as the board is
  // mounted — which is also what puts them in the shortcuts overlay. Two
  // aliases ride along: a listbox is expected to answer to the arrows, and
  // they are the same act `J`/`K` are, not a second one.
  const verbBindings = useMemo(() => bindingsFromVerbs(verbs), [verbs]);
  const queueArrowBindings = useMemo<readonly KeyBinding[]>(
    () => [
      {
        kind: "dispatched",
        id: "queue-move-arrows",
        chords: [{ key: "ArrowDown" }, { key: "ArrowUp" }],
        keysLabel: "↓ / ↑",
        label: "move through the attention queue",
        description:
          "moves the highlight while the queue has focus — the same act as J/K",
        scope: "queue",
        run: (_event, chord) =>
          queueCursor.move(chord.key === "ArrowDown" ? "next" : "prev"),
      },
    ],
    [queueCursor],
  );
  useKeyBindings(verbBindings);
  useKeyBindings(queueArrowBindings);

  // Command palette (§11): one keyboard entry point for navigation and
  // every verb. Navigation items always resolve through `select` — the same
  // selection-as-route primitive the canvas click uses (§5) — and the verb
  // rows come from the same `verbs` the bindings do, each showing its own key.
  const commandPaletteItems = useMemo<readonly CommandPaletteItem[]>(
    () => [
      ...(graph?.nodes ?? []).map((node): CommandPaletteItem => ({
        id: `nav-${node.id}`,
        label: node.label,
        kind: "navigate",
        nodeId: node.id,
      })),
      ...commandPaletteItemsFromVerbs(verbs, (verb) => {
        const binding = verbBindings.find(
          (candidate) => candidate.id === verb.id,
        );
        return binding ? bindingKeysLabel(binding) : undefined;
      }),
      // Plugin-contributed verbs (§10.1, §11): empty today —
      // `contributionRegistry` has nothing registered until an in-box
      // plugin's manifest lands — but resolved through the same call a
      // registered one would go through.
      ...commandPaletteItemsFromRegistry(contributionRegistry),
    ],
    [graph, verbs, verbBindings],
  );

  // Ordered context inputs into the selected command (§3.5), read from the
  // live graph and persisted on reorder via POST /api/nodes/:id/context/order.
  const contextInputs = useMemo<readonly ContextInputRow[]>(() => {
    if (!graph || !selectedNodeId) return [];
    const labelOf = new Map(graph.nodes.map((node) => [node.id, node.label]));
    return graph.contextEdges
      .filter((edge) => edge.to === selectedNodeId)
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((edge) => ({
        id: edge.id,
        ordinal: edge.ordinal,
        label: labelOf.get(edge.from) ?? edge.from,
      }));
  }, [graph, selectedNodeId]);

  const panelRegistry = useMemo(() => {
    const registry = createPanelRegistry();
    registry.register(
      definePanel<Note>({
        id: "notes",
        title: "Notes",
        initialState: initialNote,
        render: ({ state, setState }) => (
          <NotePanel
            note={state}
            author={humanAuthor}
            now={now}
            onChange={setState}
          />
        ),
      }),
    );
    registry.register(
      definePanel<null>({
        id: "warnings",
        title: "Warnings",
        initialState: null,
        render: () => (
          <GraphWarningsPanel warnings={warnings} onSelectNode={select} />
        ),
      }),
    );
    registry.register(
      definePanel<null>({
        id: "conversation",
        title: "Conversation",
        initialState: null,
        render: () =>
          selectedSessionId ? (
            <ConversationPanel
              sessionId={selectedSessionId}
              dataSource={sessionDataSource}
              draftsStore={sessionDraftsStore}
              sendDisabledReason={SEND_DISABLED_REASON}
              onSend={(sessionId, text) => {
                void actions
                  .injectIntoSession({ sessionId, text })
                  .then((result) => {
                    if (!result.ok) {
                      log(
                        `refused: ${result.refusal.reason} - ${result.refusal.message}`,
                      );
                      return;
                    }
                    log(
                      `injected into ${sessionId}: ${result.value.status}${result.value.refusedReason ? ` (${result.value.refusedReason})` : ""}`,
                    );
                  });
              }}
              checkpointDisabledReason={CHECKPOINT_DISABLED_REASON}
              onCheckpointTranscript={(sessionId) => {
                void actions.checkpointTranscript(sessionId).then((result) => {
                  if (!result.ok) {
                    log(
                      `refused: ${result.refusal.reason} - ${result.refusal.message}`,
                    );
                    return;
                  }
                  log(
                    result.value.publication === null
                      ? `checkpoint ${sessionId}: nothing new to publish`
                      : `checkpoint ${sessionId}: published version ${result.value.publication.ordinal} (through turn ${result.value.publication.throughTurn})`,
                  );
                });
              }}
              onWireAsContext={(sessionId, turnOrdinal, item) =>
                log(
                  `wire as context: session ${sessionId} turn ${turnOrdinal} (${item.kind}) — not yet wired`,
                )
              }
              onResume={(sessionId) => {
                void actions
                  .resumeSession({
                    sessionId,
                    initiationKey: `resume-${crypto.randomUUID()}`,
                  })
                  .then((result) => {
                    if (!result.ok) {
                      log(
                        `refused: ${result.refusal.reason} - ${result.refusal.message}`,
                      );
                      return;
                    }
                    log(`resumed ${result.value.sessionId}`);
                  });
              }}
              onFork={(sessionId, turn) => {
                void actions
                  .forkSession({
                    sessionId,
                    turn,
                    initiationKey: `fork-${crypto.randomUUID()}`,
                  })
                  .then((result) => {
                    if (!result.ok) {
                      log(
                        `refused: ${result.refusal.reason} - ${result.refusal.message}`,
                      );
                      return;
                    }
                    log(
                      `forked ${sessionId} at turn ${turn} into session ${result.value.sessionId} (workstream ${result.value.workstreamId}, mode ${result.value.mode})`,
                    );
                  });
              }}
              handoffBriefs={
                handoffBriefsBySession.get(selectedSessionId) ?? []
              }
              onRequestHandoffBrief={(sessionId) => {
                if (!LIVE) {
                  log("offline mode: requesting a handoff brief was not saved");
                  return;
                }
                void actions.writeHandoffBrief({ sessionId }).then((result) => {
                  if (!result.ok) {
                    log(
                      `refused: ${result.refusal.reason} - ${result.refusal.message}`,
                    );
                    return;
                  }
                  log(`drafted handoff brief ${result.value.brief.id}`);
                  refreshHandoffBriefs(sessionId);
                });
              }}
              onReviewHandoffBrief={(briefId, text) => {
                if (!LIVE) {
                  log(
                    "offline mode: reviewing the handoff brief was not saved",
                  );
                  return;
                }
                void actions
                  .reviewHandoffBrief({
                    briefId,
                    ...(text === undefined ? {} : { text }),
                  })
                  .then((result) => {
                    if (!result.ok) {
                      log(
                        `refused: ${result.refusal.reason} - ${result.refusal.message}`,
                      );
                      return;
                    }
                    log(`reviewed handoff brief ${briefId}`);
                    refreshHandoffBriefs(result.value.brief.sourceSessionId);
                  });
              }}
              onSendHandoff={(briefId, workstreamId) => {
                if (!LIVE) {
                  log("offline mode: sending the handoff was not saved");
                  return;
                }
                void actions
                  .sendHandoff({
                    briefId,
                    workstreamId,
                    initiationKey: `handoff-${crypto.randomUUID()}`,
                  })
                  .then((result) => {
                    if (!result.ok) {
                      log(
                        `refused: ${result.refusal.reason} - ${result.refusal.message}`,
                      );
                      return;
                    }
                    log(
                      `sent handoff ${briefId} into workstream ${workstreamId}: session ${result.value.sessionId}`,
                    );
                  });
              }}
              continuation={continuationPreview}
            />
          ) : (
            <div>select a session node to see its conversation</div>
          ),
      }),
    );
    registry.register(
      definePanel<null>({
        id: "diff",
        title: "Diff",
        initialState: null,
        render: () =>
          selectedWorkstreamId ? (
            <DiffPanel
              workstreamId={selectedWorkstreamId}
              dataSource={diffDataSource}
            />
          ) : (
            <div>select a node inside a workstream to see its diff</div>
          ),
      }),
    );
    registry.register(
      definePanel<null>({
        id: "stop",
        title: "Stop",
        initialState: null,
        render: () => (
          <StopControls
            selectedSessionId={selectedSessionId}
            selectedWorkstreamId={selectedWorkstreamId}
            previewStop={actions.previewStop}
            stopScope={actions.stopScope}
            onStopped={(scope, stoppedSessionIds) =>
              log(
                `stopped (${scope.scope}): ${stoppedSessionIds.length ? stoppedSessionIds.join(", ") : "nothing was running"}`,
              )
            }
            onRefused={(scope, message) =>
              log(`refused to stop (${scope.scope}): ${message}`)
            }
          />
        ),
      }),
    );
    registry.register(
      definePanel<null>({
        id: "queue",
        title: "Queue",
        initialState: null,
        render: () => <QueuePanel cursor={queueCursor} />,
      }),
    );
    registry.register(
      definePanel<null>({
        id: "what-changed",
        title: "What changed",
        initialState: null,
        render: () => (
          <WhatChangedPanel
            dataSource={activityDataSource}
            workstreamNames={workstreamNames}
            nodeExists={(nodeId) =>
              graph?.nodes.some((node) => node.id === nodeId) ?? false
            }
            onNavigate={select}
          />
        ),
      }),
    );
    registry.register(
      definePanel<null>({
        id: "fleet",
        title: "Fleet",
        initialState: null,
        render: () => <FleetPanel dataSource={fleetDataSource} />,
      }),
    );
    registry.register(
      definePanel<null>({
        id: "search",
        title: "Search",
        initialState: null,
        render: () => (
          <SearchPanel dataSource={searchDataSource} onSelectNode={select} />
        ),
      }),
    );
    registry.register(
      definePanel<null>({
        id: "settings",
        title: "Settings",
        initialState: null,
        render: () => <SettingsPanel dataSource={settingsDataSource} />,
      }),
    );
    registry.register(
      definePanel<null>({
        id: "logs",
        title: "Logs",
        initialState: null,
        render: () => <LogsPanel dataSource={logsDataSource} />,
      }),
    );
    registry.register(
      definePanel<null>({
        id: "timeline",
        title: "Timeline",
        initialState: null,
        render: () =>
          selectedSessionId ? (
            <TimelinePanel sessionId={selectedSessionId} http={httpClient} />
          ) : (
            <div>select a session node to see its timeline</div>
          ),
      }),
    );
    registry.register(
      definePanel<null>({
        id: "plugins",
        title: "Plugins",
        initialState: null,
        render: () => (
          <PluginHealthPanel
            dataSource={pluginHealthDataSource}
            actions={pluginLifecycleActions}
          />
        ),
      }),
    );
    // Plugin-contributed panels (§10.1, §11): registered through the exact
    // same `register` call above — empty today (`contributionRegistry` has
    // no manifests yet), so this changes nothing about what the dock rail
    // shows until an in-box plugin's manifest contributes one.
    for (const panel of panelDefinitionsFromRegistry(contributionRegistry)) {
      registry.register(panel);
    }
    return registry;
  }, [
    initialNote,
    warnings,
    select,
    selectedSessionId,
    selectedWorkstreamId,
    graph,
    handoffBriefsBySession,
    continuationPreview,
  ]);

  if (placements === null || graph === null) {
    return null;
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100vw",
        height: "100vh",
      }}
    >
      {/* The header indicator (§7): one derivation, rendered here as a plain count. */}
      <div
        data-testid="attention-header-count"
        style={{ borderBottom: "1px solid black", padding: 4 }}
      >
        attention: {attentionTotal}
      </div>
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <div style={{ width: 240, borderRight: "1px solid black", padding: 8 }}>
          <h2>palette (§5)</h2>
          <PaletteRail
            entries={graph.paletteEntries}
            // The keyboard's equivalent of dropping a row on the canvas
            // (§11): the same `placeNode` action the drop calls, at a position
            // the derived arrangement will resolve rather than one a pointer
            // supplied — so a keyboard user can place anything a mouse can.
            onActivateEntry={placePaletteEntry}
          />
        </div>

        <div style={{ width: "100%", height: "100%" }}>
          <CommandPalette
            items={commandPaletteItems}
            onSelectNode={select}
            onRunVerb={(itemId) => {
              // One vocabulary (§11, principle 8): a palette row runs the
              // *same* verb definition its keyboard binding does — there is no
              // second switch over verb ids here.
              if (runAppVerb(verbs, itemId)) return;
              // Plugin-contributed verbs (§10.1) are the only other rows the
              // palette can hold; `false` means nothing owned that id.
              void invokePluginPaletteEntry(contributionRegistry, itemId).then(
                (handled) => {
                  log(
                    handled
                      ? `ran plugin verb: ${itemId}`
                      : `no verb owns ${itemId}`,
                  );
                },
              );
            }}
          />
          {/* Every binding, listed from the registry that dispatches them
              (§11) — opened by the `?` verb above. */}
          <ShortcutsOverlay
            open={shortcutsOpen}
            onClose={() => setShortcutsOpen(false)}
          />
          <PlotCanvas
            nodes={graph.nodes}
            edges={graph.edges}
            containers={graph.containers}
            arrangementEpoch={arrangementEpoch}
            bubbleSources={bubbleSources}
            onAnswerQuestion={(source, option) => {
              const questionId = source.id.split(":question:").at(-1);
              if (!questionId) return;
              void questionDataSource.answer(questionId, option);
            }}
            collapsedContainerIds={collapsedContainerIds}
            onToggleContainer={(containerId) =>
              setCollapsedContainerIds((current) => {
                const next = new Set(current);
                if (next.has(containerId)) {
                  next.delete(containerId);
                } else {
                  next.add(containerId);
                }
                return next;
              })
            }
            placements={placements}
            onPlacementsChange={(delta) => {
              // `delta` is only what this gesture actually moved — the
              // dragged node and whatever the rigid-body push chain
              // displaced (`PlotCanvas`'s own `drag-diff.ts`), never every
              // node currently on screen.
              setPlacements((current) => ({ ...current, ...delta }));
              if (LIVE) {
                arrangementWriteQueue.enqueue(delta);
              } else {
                // Fixture/offline mode still has no server, so the full
                // merged map is what localStorage keeps durable across a
                // reload, exactly as before.
                void localPlacementStore.save({
                  ...(placementsRef.current ?? {}),
                  ...delta,
                });
              }
            }}
            selectedNodeId={selectedNodeId}
            onSelectNode={select}
            attentionNodeIds={attentionNodeIds}
            attentionByNodeId={attentionByNodeId}
            warningsByNodeId={warningsByNodeId}
            onCardAction={(nodeId, actionId) => {
              // Plugin card actions (§10.1): a write action routes through
              // §6.6's approvals same as any other write once a plugin
              // contributes one — nothing does yet, so this only logs.
              log(
                `card action ${actionId} on ${nodeId} (not yet wired to /api)`,
              );
            }}
            onBatchAction={(action, ids) => {
              log(`batch ${action}: ${ids.join(", ")}`);
            }}
            onCreateFromDrag={(sourceId, option) => {
              log(
                `create ${option.kind} from ${sourceId} (not yet wired to /api)`,
              );
            }}
            onWireContext={(from, to) => {
              if (!LIVE) {
                log(`offline mode: wiring ${from} -> ${to} was not saved`);
                return;
              }
              void actions.addContextEdge({ from, to }).then((result) => {
                if (!result.ok) {
                  log(
                    `refused: ${result.refusal.reason} - ${result.refusal.message}`,
                  );
                }
              });
            }}
            onDropDefinitionOnTicket={(ticketNodeId, definitionId) => {
              if (!LIVE) {
                log(
                  `offline mode: dropping definition ${definitionId} onto ${ticketNodeId} was not saved`,
                );
                return;
              }
              const ticket = graph.nodes.find(
                (node) => node.id === ticketNodeId,
              );
              if (!ticket?.refId) return;
              void (async () => {
                const workstream = await actions.createWorkstream(ticket.refId);
                if (!workstream.ok) {
                  log(
                    `refused: ${workstream.refusal.reason} - ${workstream.refusal.message}`,
                  );
                  return;
                }
                const command = await actions.instantiateCommand({
                  definitionId,
                  workstreamId: workstream.value.workstreamId,
                  context: [ticketNodeId],
                });
                if (!command.ok) {
                  log(
                    `refused: ${command.refusal.reason} - ${command.refusal.message}`,
                  );
                  return;
                }
                log(
                  `workstream ${workstream.value.workstreamId} created from ${ticketNodeId}, ` +
                    `command ${command.value.commandId} wired with an authored context edge`,
                );
              })();
            }}
            onDropPaletteEntry={placePaletteEntry}
            runningCommandNodeIds={runsInFlight}
            onRunCommand={runCommandNode}
          />
        </div>

        {/* Unstyled side panel: mechanics only (fleet rule 5). */}
        <div
          style={{
            width: 320,
            borderLeft: "1px solid black",
            padding: 8,
            overflow: "auto",
          }}
        >
          <section>
            <h2>context inputs into the selected command (§3.5)</h2>
            {selectedNodeId ? (
              <ContextInputList
                edges={contextInputs}
                onReorder={(reordered) => {
                  if (!LIVE) {
                    log("offline mode: reordering context was not saved");
                    return;
                  }
                  void actions
                    .reorderContext(
                      selectedNodeId,
                      reordered.map((edge) => edge.id),
                    )
                    .then((result) => {
                      if (!result.ok) {
                        log(
                          `refused: ${result.refusal.reason} - ${result.refusal.message}`,
                        );
                      }
                    });
                }}
              />
            ) : (
              <div>select a command to see its context inputs</div>
            )}
          </section>

          <section>
            <h2>collection (§3.1)</h2>
            <button
              type="button"
              onClick={() => setCollection(expandCollection(collection))}
            >
              expand
            </button>
            {collection.expanded ? (
              <ul>
                {collection.memberIds.map((memberId) => (
                  <li key={memberId}>
                    {memberId}{" "}
                    <button
                      type="button"
                      onClick={() =>
                        setCollection(pruneMember(collection, memberId))
                      }
                    >
                      prune
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const result = dragOutMember(collection, memberId);
                        setCollection(result.collection);
                        if (result.draggedId) {
                          log(`dragged out ${result.draggedId}`);
                        }
                      }}
                    >
                      drag out
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section>
            <h2>queued runs (§4.1)</h2>
            {queuedRuns.size === 0 ? (
              <div>nothing waiting on the concurrency limit</div>
            ) : (
              <ul>
                {[...queuedRuns.entries()].map(([commandNodeId, queued]) => (
                  <li
                    key={commandNodeId}
                    data-testid={`queued-run-${commandNodeId}`}
                  >
                    {commandNodeId}: position {queued.position ?? "?"}{" "}
                    <button
                      type="button"
                      onClick={() => {
                        void actions
                          .cancelQueuedRun(queued.queueEntryId)
                          .then((result) => {
                            setQueuedRuns((current) => {
                              const next = new Map(current);
                              next.delete(commandNodeId);
                              return next;
                            });
                            if (!result.ok) {
                              log(
                                `refused to cancel queued run: ${result.refusal.message}`,
                              );
                              return;
                            }
                            log(
                              result.value.cancelled
                                ? `cancelled queued run for ${commandNodeId}`
                                : `queued run for ${commandNodeId} had already started or settled`,
                            );
                          });
                      }}
                    >
                      cancel
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2>gesture log</h2>
            <ul>
              {gestureLog.map((entry, index) => (
                <li key={index}>{entry}</li>
              ))}
            </ul>
          </section>
        </div>

        <div style={{ width: 320, borderLeft: "1px solid black" }}>
          <h2>dock rail (§11)</h2>
          <DockRail registry={panelRegistry} />
        </div>
      </div>
    </div>
  );
}
