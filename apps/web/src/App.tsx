import { useEffect, useMemo, useState } from "react";
import { humanAuthor } from "@plotroom/core";
import type {
  CommandPaletteItem,
  ContextInputRow,
  Collection,
  GraphSnapshot,
  Note,
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
  browserWebSocketFactory,
  createApiActions,
  createApiGraphDataSource,
  createFixtureGraphDataSource,
  createFixtureSessionDataSource,
  createHttpClient,
  createNote,
  createPanelRegistry,
  createWebStoragePlacementStore,
  createWebStorageSessionDraftsStore,
  definePanel,
  deriveGraphWarnings,
  deriveInitialArrangement,
  dragOutMember,
  expandCollection,
  pruneMember,
  useSelectionRoute,
} from "@plotroom/ui";
import type { WarningGraphNode } from "@plotroom/ui";

import {
  FIXTURE_COLLECTION,
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

const graphDataSource = LIVE
  ? createApiGraphDataSource({
      http: httpClient,
      createSocket: browserWebSocketFactory(),
    })
  : createFixtureGraphDataSource(FIXTURE_SNAPSHOT);

const actions = createApiActions(httpClient);

/**
 * The session data seam (Epic 5.1, Stage 1 of 2): fixture-fed regardless of
 * `LIVE` — no sessions server API exists yet (Track A, in parallel), unlike
 * the graph seam above. Stage 2 adds a live `SessionDataSource` the exact
 * same way `createApiGraphDataSource` was added here for the graph.
 */
const sessionDataSource = createFixtureSessionDataSource({
  sessions: FIXTURE_SESSIONS,
  transcripts: new Map([[FIXTURE_TRANSCRIPT.sessionId, FIXTURE_TRANSCRIPT]]),
  script: FIXTURE_TRANSCRIPT_SCRIPT,
  releasedContent: FIXTURE_RELEASED_CONTENT,
});

/** Drafts and prompt history persist per session (§6.2), the same durable-store seam as placement. */
const sessionDraftsStore = createWebStorageSessionDraftsStore(
  window.localStorage,
  "plotroom.session-drafts.v1",
);

const now = () => Date.now();

export function App() {
  const [placements, setPlacements] = useState<Placements | null>(null);
  const { selectedNodeId, select } = useSelectionRoute();

  // Fixture-fed lookup (Stage 1): a session node's id is the session's own
  // id (`sessions/canvas-node.ts`'s `refId`); Stage 2 resolves this against
  // a live `SessionDataSource` instead.
  const selectedSession = useMemo(
    () =>
      FIXTURE_SESSIONS.find((session) => session.id === selectedNodeId) ?? null,
    [selectedNodeId],
  );

  const [graph, setGraph] = useState<GraphSnapshot | null>(null);

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
          selectedSession ? (
            <ConversationPanel
              session={selectedSession}
              status={
                FIXTURE_SESSION_STATUSES.get(selectedSession.id) ?? {
                  phase: { kind: "idle" },
                  facts: { busy: false, wantsAttention: false },
                  health: { silentForMs: 0, possiblyStalled: false },
                }
              }
              dataSource={sessionDataSource}
              draftsStore={sessionDraftsStore}
              now={now}
              onSend={(sessionId, text) =>
                log(`send to ${sessionId} (no-op against fixtures): ${text}`)
              }
              onWireAsContext={(sessionId, turnOrdinal, item) =>
                log(
                  `wire as context: session ${sessionId} turn ${turnOrdinal} (${item.kind}) — not yet wired`,
                )
              }
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
        render: () => <DiffPanel diff={FIXTURE_WORKSPACE_DIFF} />,
      }),
    );
    return registry;
  }, [initialNote, warnings, select, selectedSession]);

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
              log("reset arrangement: re-derived from graph structure");
            }
          }}
        />
        <PlotCanvas
          nodes={graph.nodes}
          edges={graph.edges}
          containers={graph.containers}
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
