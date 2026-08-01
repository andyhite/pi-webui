import { useEffect, useMemo, useState } from "react";
import type { NodeId } from "@plotroom/core";
import { humanAuthor } from "@plotroom/core";
import type {
  CanvasNodeInput,
  Collection,
  CommandPaletteItem,
  ContextInputRow,
  GraphSnapshot,
  Note,
  PaletteEntry,
  Placements,
} from "@plotroom/ui";
import {
  CommandPalette,
  ContextInputList,
  DockRail,
  GraphWarningsPanel,
  NotePanel,
  PaletteRail,
  PlotCanvas,
  createFixtureGraphDataSource,
  createNote,
  createPanelRegistry,
  createWebStoragePlacementStore,
  createWorkstreamFromDrop,
  definePanel,
  deriveGraphWarnings,
  dragOutMember,
  expandCollection,
  pruneMember,
  unplacedEntries,
  useSelectionRoute,
} from "@plotroom/ui";

import {
  FIXTURE_COLLECTION,
  FIXTURE_CONTAINERS,
  FIXTURE_CONTEXT_INPUTS,
  FIXTURE_EDGES,
  FIXTURE_NODES,
  FIXTURE_PALETTE_ENTRIES,
  toWarningGraphNodes,
} from "./fixtures.js";

/**
 * Placement is durable across reloads (spec §5). localStorage stands in for
 * the server API (Phase 2); the canvas only ever sees the PlacementStore
 * interface, so the swap will not touch it.
 */
const placementStore = createWebStoragePlacementStore(
  window.localStorage,
  "plotroom.placements.v1",
);

/**
 * The graph data seam (Epic 3.0): the canvas is fed by a `GraphDataSource`,
 * never by fixtures directly. Stage 2 (Sync 2) swaps this one call for
 * `createApiGraphDataSource(httpClient)` — nothing downstream of `load()`
 * changes.
 */
const graphDataSource = createFixtureGraphDataSource({
  nodes: FIXTURE_NODES,
  edges: FIXTURE_EDGES,
  containers: FIXTURE_CONTAINERS,
});

const now = () => Date.now();

/** Content kinds the palette places directly on drop (§5); commands aren't. */
function roleForPaletteEntry(entry: PaletteEntry): "content" | "session" {
  return entry.kind === "session" ? "session" : "content";
}

export function App() {
  const [placements, setPlacements] = useState<Placements | null>(null);
  const { selectedNodeId, select } = useSelectionRoute();

  const [graph, setGraph] = useState<GraphSnapshot | null>(null);

  const [collapsedContainerIds, setCollapsedContainerIds] = useState<
    Set<string>
  >(() => new Set());

  // §3.5: edge order is assembly order, rearrangeable by drag.
  const [contextInputs, setContextInputs] = useState<
    readonly ContextInputRow[]
  >(FIXTURE_CONTEXT_INPUTS);

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

  // §3.1: a collection expands, prunes, and drags members out.
  const [collection, setCollection] = useState<Collection>(() => ({
    ...FIXTURE_COLLECTION,
    expanded: false,
  }));

  // §3.5/§3.3: one gesture — dropping a command definition onto a bare
  // ticket — creates a workstream. The result is logged rather than
  // spliced into the fixture graph as new nodes, which would need real
  // command-node content this epic's fixtures don't model yet (Track A's
  // command schema, Epic 1.4, has not landed).
  const [gestureLog, setGestureLog] = useState<readonly string[]>([]);

  // Palette entries the operator has dragged onto the canvas (§5): once
  // placed they leave the rail and become plain canvas nodes.
  const [droppedNodes, setDroppedNodes] = useState<readonly CanvasNodeInput[]>(
    [],
  );
  const [placedEntryIds, setPlacedEntryIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  useEffect(() => {
    let cancelled = false;
    void placementStore.load().then((loaded) => {
      if (!cancelled) setPlacements(loaded);
    });
    void graphDataSource.load().then((loaded) => {
      if (!cancelled) setGraph(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const attentionNodeIds = useMemo(() => ["ticket-off-screen"], []);

  const allNodes = useMemo<readonly CanvasNodeInput[]>(
    () => [...(graph?.nodes ?? []), ...droppedNodes],
    [graph, droppedNodes],
  );

  // Graph warnings (§5): pure derivation over the graph, re-run whenever it
  // changes. Never a refusal — read here and in the editor surface below.
  const warnings = useMemo(
    () =>
      deriveGraphWarnings(
        toWarningGraphNodes(allNodes),
        (graph?.edges ?? []).map((edge) => ({
          from: edge.source,
          to: edge.target,
        })),
      ),
    [allNodes, graph],
  );

  const warningsByNodeId = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const warning of warnings) {
      const existing = map.get(warning.nodeId) ?? [];
      existing.push(warning.message);
      map.set(warning.nodeId, existing);
    }
    return map;
  }, [warnings]);

  const paletteEntries = useMemo(
    () => unplacedEntries(FIXTURE_PALETTE_ENTRIES, placedEntryIds),
    [placedEntryIds],
  );

  // Command palette (§11): one keyboard entry point for navigation and
  // every verb. Navigation items always resolve through `select` — the same
  // selection-as-route primitive the canvas click uses (§5).
  const commandPaletteItems = useMemo<readonly CommandPaletteItem[]>(
    () => [
      ...allNodes.map((node): CommandPaletteItem => ({
        id: `nav-${node.id}`,
        label: node.label,
        kind: "navigate",
        nodeId: node.id,
      })),
      { id: "verb-clear-log", label: "clear gesture log", kind: "verb" },
    ],
    [allNodes],
  );

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
    return registry;
  }, [initialNote, warnings, select]);

  if (placements === null || graph === null) {
    return null;
  }

  return (
    <div style={{ display: "flex", width: "100vw", height: "100vh" }}>
      <div style={{ width: 240, borderRight: "1px solid black", padding: 8 }}>
        <h2>palette (§5)</h2>
        <PaletteRail entries={paletteEntries} />
      </div>

      <div style={{ width: "100%", height: "100%" }}>
        <CommandPalette
          items={commandPaletteItems}
          onSelectNode={select}
          onRunVerb={(itemId) => {
            if (itemId === "verb-clear-log") setGestureLog([]);
          }}
        />
        <PlotCanvas
          nodes={allNodes}
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
            void placementStore.save(next);
          }}
          selectedNodeId={selectedNodeId}
          onSelectNode={select}
          attentionNodeIds={attentionNodeIds}
          warningsByNodeId={warningsByNodeId}
          onBatchAction={(action, ids) => {
            setGestureLog((log) => [
              ...log,
              `batch ${action}: ${ids.join(", ")}`,
            ]);
          }}
          onCreateFromDrag={(sourceId, option) => {
            setGestureLog((log) => [
              ...log,
              `create ${option.kind} from ${sourceId}`,
            ]);
          }}
          onDropDefinitionOnTicket={(ticketNodeId) => {
            const result = createWorkstreamFromDrop(
              ticketNodeId as NodeId,
              `command-${crypto.randomUUID()}` as NodeId,
              humanAuthor,
              now(),
            );
            setGestureLog((log) => [
              ...log,
              `workstream ${result.workstreamId} created from ${ticketNodeId}, ` +
                `command ${result.commandNodeId} wired with an authored context edge`,
            ]);
          }}
          onDropPaletteEntry={(entryId, position) => {
            const entry = FIXTURE_PALETTE_ENTRIES.find((e) => e.id === entryId);
            if (!entry) return;
            setDroppedNodes((current) => [
              ...current,
              {
                id: entry.id,
                label: entry.label,
                role: roleForPaletteEntry(entry),
                ...(entry.kind === "session" ? { running: false } : {}),
                defaultPosition: position,
              },
            ]);
            setPlacedEntryIds((current) => new Set([...current, entryId]));
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
          <h2>context inputs into command-implement (§3.5)</h2>
          <ContextInputList
            edges={contextInputs}
            onReorder={setContextInputs}
          />
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
                        setGestureLog((log) => [
                          ...log,
                          `dragged out ${result.draggedId}`,
                        ]);
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
