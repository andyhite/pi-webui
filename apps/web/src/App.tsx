import { useEffect, useState } from "react";
import type { Placements } from "@plotroom/ui";
import {
  PlotCanvas,
  createWebStoragePlacementStore,
  useSelectionRoute,
} from "@plotroom/ui";

import { FIXTURE_EDGES, FIXTURE_NODES } from "./fixtures.js";

/**
 * Placement is durable across reloads (spec §5). localStorage stands in for
 * the server API (Phase 2); the canvas only ever sees the PlacementStore
 * interface, so the swap will not touch it.
 */
const placementStore = createWebStoragePlacementStore(
  window.localStorage,
  "plotroom.placements.v1",
);

export function App() {
  const [placements, setPlacements] = useState<Placements | null>(null);
  const { selectedNodeId, select } = useSelectionRoute();

  useEffect(() => {
    let cancelled = false;
    void placementStore.load().then((loaded) => {
      if (!cancelled) setPlacements(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (placements === null) {
    return null;
  }

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <PlotCanvas
        nodes={FIXTURE_NODES}
        edges={FIXTURE_EDGES}
        placements={placements}
        onPlacementsChange={(next) => {
          void placementStore.save(next);
        }}
        selectedNodeId={selectedNodeId}
        onSelectNode={select}
      />
    </div>
  );
}
