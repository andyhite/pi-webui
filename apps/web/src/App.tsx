import { useEffect, useMemo, useState } from "react";
import type { NodeId } from "@plotroom/core";
import { humanAuthor } from "@plotroom/core";
import type {
  Collection,
  ContextInputRow,
  Note,
  Placements,
} from "@plotroom/ui";
import {
  COMMAND_DEFINITION_DRAG_TYPE,
  ContextInputList,
  NotePanel,
  PlotCanvas,
  createNote,
  createWebStoragePlacementStore,
  createWorkstreamFromDrop,
  dragOutMember,
  expandCollection,
  pruneMember,
  useSelectionRoute,
} from "@plotroom/ui";

import {
  FIXTURE_COLLECTION,
  FIXTURE_CONTAINERS,
  FIXTURE_CONTEXT_INPUTS,
  FIXTURE_EDGES,
  FIXTURE_NODES,
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

const now = () => Date.now();

export function App() {
  const [placements, setPlacements] = useState<Placements | null>(null);
  const { selectedNodeId, select } = useSelectionRoute();

  const [collapsedContainerIds, setCollapsedContainerIds] = useState<
    Set<string>
  >(() => new Set());

  // §3.5: edge order is assembly order, rearrangeable by drag.
  const [contextInputs, setContextInputs] = useState<
    readonly ContextInputRow[]
  >(FIXTURE_CONTEXT_INPUTS);

  // §3.8: notes are created, edited (new version), and promoted.
  const [note, setNote] = useState<Note>(() =>
    createNote(
      "note-steering",
      "Remember: this repo uses pnpm, never npm.",
      humanAuthor,
      now(),
    ),
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

  useEffect(() => {
    let cancelled = false;
    void placementStore.load().then((loaded) => {
      if (!cancelled) setPlacements(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const attentionNodeIds = useMemo(() => ["ticket-off-screen"], []);

  if (placements === null) {
    return null;
  }

  return (
    <div style={{ display: "flex", width: "100vw", height: "100vh" }}>
      <div style={{ width: "100%", height: "100%" }}>
        <PlotCanvas
          nodes={FIXTURE_NODES}
          edges={FIXTURE_EDGES}
          containers={FIXTURE_CONTAINERS}
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
          <h2>drag source (one-gesture flow, §3.5)</h2>
          <div
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData(
                COMMAND_DEFINITION_DRAG_TYPE,
                "implement",
              );
            }}
          >
            command definition: implement (drag onto the bare ticket)
          </div>
        </section>

        <section>
          <h2>context inputs into command-implement (§3.5)</h2>
          <ContextInputList
            edges={contextInputs}
            onReorder={setContextInputs}
          />
        </section>

        <section>
          <h2>note (§3.8)</h2>
          <NotePanel
            note={note}
            author={humanAuthor}
            now={now}
            onChange={setNote}
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
    </div>
  );
}
