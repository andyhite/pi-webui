import { useEffect, useMemo, useState } from "react";
import { humanAuthor } from "@plotroom/core";
import type { SessionId, SessionPhase, Transcript } from "@plotroom/core";
import type {
  BubbleSource,
  CommandPaletteItem,
  ContextInputRow,
  Collection,
  GraphSnapshot,
  Note,
  OpenQuestion,
  Placements,
} from "@plotroom/ui";
import {
  CommandPalette,
  ContextInputList,
  ConversationPanel,
  DiffPanel,
  DockRail,
  GraphWarningsPanel,
  NotePanel,
  PaletteRail,
  PlotCanvas,
  StopControls,
  beginRun,
  browserWebSocketFactory,
  createApiActions,
  createApiDiffDataSource,
  createApiGraphDataSource,
  createApiQuestionDataSource,
  createApiSessionDataSource,
  createFixtureDiffDataSource,
  createFixtureGraphDataSource,
  createFixtureQuestionDataSource,
  createFixtureSessionDataSource,
  createHttpClient,
  createNote,
  createPanelRegistry,
  createWebStoragePlacementStore,
  createWebStorageSessionDraftsStore,
  definePanel,
  deriveCommandBubbleSources,
  deriveGraphWarnings,
  deriveInitialArrangement,
  deriveInjectionBubbleSources,
  deriveSessionBubbleSources,
  dragOutMember,
  endRun,
  expandCollection,
  pruneMember,
  useSelectionRoute,
} from "@plotroom/ui";
import type { InjectionLedgerEntry, WarningGraphNode } from "@plotroom/ui";

import {
  FIXTURE_COLLECTION,
  FIXTURE_INJECTIONS,
  FIXTURE_OPEN_QUESTIONS,
  FIXTURE_RELEASED_CONTENT,
  FIXTURE_SESSIONS,
  FIXTURE_SESSION_STATUSES,
  FIXTURE_SNAPSHOT,
  FIXTURE_TRANSCRIPT,
  FIXTURE_TRANSCRIPT_SCRIPT,
  FIXTURE_WORKSPACE_DIFF,
} from "./fixtures.js";

/**
 * Placement is durable across reloads (spec §5). localStorage stands in for
 * a server-side placement store (none exists — position is client-owned,
 * not part of `PlacedNode`); the canvas only ever sees the `PlacementStore`
 * interface, so a future swap would not touch it.
 */
const placementStore = createWebStoragePlacementStore(
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

const graphDataSource = LIVE
  ? createApiGraphDataSource({ http: httpClient, createSocket: wsFactory })
  : createFixtureGraphDataSource(FIXTURE_SNAPSHOT);

const actions = createApiActions(httpClient);

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

/** Drafts and prompt history persist per session (§6.2), the same durable-store seam as placement. */
const sessionDraftsStore = createWebStorageSessionDraftsStore(
  window.localStorage,
  "plotroom.session-drafts.v1",
);

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

export function App() {
  const [placements, setPlacements] = useState<Placements | null>(null);
  // A one-shot bump for PlotCanvas's `arrangementEpoch` prop: writing fresh
  // `placements` alone never moves an already-mounted node (durable
  // placement means nothing may react to `placements` changing on its own,
  // spec §5) — "reset arrangement" also bumps this counter so the canvas
  // applies the fresh positions to nodes already on screen, exactly once.
  const [arrangementEpoch, setArrangementEpoch] = useState(0);
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

  const [collapsedContainerIds, setCollapsedContainerIds] = useState<
    Set<string>
  >(() => new Set());

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

  useEffect(() => {
    let cancelled = false;
    void placementStore.load().then((loaded) => {
      if (!cancelled) setPlacements(loaded);
    });
    const unsubscribe = graphDataSource.subscribe((snapshot) => {
      if (!cancelled) setGraph(snapshot);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const attentionNodeIds = useMemo<readonly string[]>(() => [], []);

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

  // Command palette (§11): one keyboard entry point for navigation and
  // every verb. Navigation items always resolve through `select` — the same
  // selection-as-route primitive the canvas click uses (§5).
  const commandPaletteItems = useMemo<readonly CommandPaletteItem[]>(
    () => [
      ...(graph?.nodes ?? []).map((node): CommandPaletteItem => ({
        id: `nav-${node.id}`,
        label: node.label,
        kind: "navigate",
        nodeId: node.id,
      })),
      { id: "verb-clear-log", label: "clear gesture log", kind: "verb" },
      {
        id: "verb-reset-arrangement",
        label: "reset arrangement",
        kind: "verb",
      },
    ],
    [graph],
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
    return registry;
  }, [initialNote, warnings, select, selectedSessionId, selectedWorkstreamId]);

  if (placements === null || graph === null) {
    return null;
  }

  return (
    <div style={{ display: "flex", width: "100vw", height: "100vh" }}>
      <div style={{ width: 240, borderRight: "1px solid black", padding: 8 }}>
        <h2>palette (§5)</h2>
        <PaletteRail entries={graph.paletteEntries} />
      </div>

      <div style={{ width: "100%", height: "100%" }}>
        <CommandPalette
          items={commandPaletteItems}
          onSelectNode={select}
          onRunVerb={(itemId) => {
            if (itemId === "verb-clear-log") setGestureLog([]);
            if (itemId === "verb-reset-arrangement") {
              // §5's only automatic-layout verb: re-derive every position from
              // the graph's own structure, discarding whatever was stored.
              const next = deriveInitialArrangement(
                graph.nodes.map((node) => ({
                  id: node.id,
                  ...(node.containerId
                    ? { containerId: node.containerId }
                    : {}),
                })),
                graph.edges.map((edge) => ({
                  source: edge.source,
                  target: edge.target,
                })),
                graph.containers.map((container) => ({ id: container.id })),
              );
              setPlacements(next);
              void placementStore.save(next);
              // A fresh `placements` value alone never moves an
              // already-mounted node; this bump is what actually applies
              // it, exactly once, to every node currently on the canvas.
              setArrangementEpoch((epoch) => epoch + 1);
              log("reset arrangement: re-derived from graph structure");
            }
          }}
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
          onPlacementsChange={(next) => {
            setPlacements(next);
            void placementStore.save(next);
          }}
          selectedNodeId={selectedNodeId}
          onSelectNode={select}
          attentionNodeIds={attentionNodeIds}
          warningsByNodeId={warningsByNodeId}
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
            const ticket = graph.nodes.find((node) => node.id === ticketNodeId);
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
          onDropPaletteEntry={(entryId, position) => {
            if (!LIVE) {
              log(`offline mode: dropping ${entryId} was not saved`);
              return;
            }
            const entry = graph.paletteEntries.find((e) => e.id === entryId);
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
                  log(
                    `refused: ${result.refusal.reason} - ${result.refusal.message}`,
                  );
                  return;
                }
                setPlacements((current) => {
                  const next = { ...current, [result.value.nodeId]: position };
                  void placementStore.save(next);
                  return next;
                });
              });
          }}
          runningCommandNodeIds={runsInFlight}
          onRunCommand={(commandNodeId) => {
            if (!LIVE) {
              log(`offline mode: running ${commandNodeId} was not started`);
              return;
            }
            // The gesture-level guard (§4.1, principle 9): a double-click
            // before the first request settles must not mint a second
            // initiation key. Checked and applied via one state update, so
            // two clicks handled in the same tick cannot both read "not yet
            // in flight".
            let guardedIn = false;
            setRunsInFlight((current) => {
              const guard = beginRun(current, commandNodeId);
              guardedIn = guard.allowed;
              return guard.inFlight;
            });
            if (!guardedIn) {
              log(
                `run already in flight for ${commandNodeId}; ignoring the extra click`,
              );
              return;
            }

            const commandNode = graph.nodes.find(
              (node) => node.id === commandNodeId,
            );
            if (!commandNode?.refId) {
              setRunsInFlight((current) => endRun(current, commandNodeId));
              return;
            }
            // The client's own idea of "this gesture" (principle 9): a retry
            // with the same key would get the same run and session back,
            // never a second one — a fresh key per click is exactly one run
            // per click.
            const initiationKey = `run-${crypto.randomUUID()}`;
            void actions
              .runCommand({ commandId: commandNode.refId, initiationKey })
              .then((result) => {
                setRunsInFlight((current) => endRun(current, commandNodeId));
                if (!result.ok) {
                  log(
                    `refused: ${result.refusal.reason} - ${result.refusal.message}`,
                  );
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
                log(
                  `run ${outcome.runId} started; session ${outcome.sessionId}`,
                );
              });
          }}
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
  );
}
