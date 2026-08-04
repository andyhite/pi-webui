/**
 * The seam Stage 2 (Sync 2) swaps: the canvas is fed by a `GraphDataSource`,
 * never by fixtures directly. `createFixtureGraphDataSource` is the fixture
 * implementation, kept around for tests and dev-offline;
 * `createApiGraphDataSource` (data-source/api.ts) is the live one, over
 * `GET /api/snapshot` plus `/ws` — the app swaps which one it constructs and
 * nothing that consumes `GraphDataSource` changes.
 */

import type {
  CanvasContainerInput,
  CanvasEdgeInput,
  CanvasNodeInput,
} from "../canvas/PlotCanvas.js";
import type { PaletteEntry } from "../palette/model.js";
import type { Point } from "../solver/push.js";

/**
 * Facts `deriveGraphWarnings` needs beyond a node's role (spec §3.5, §5):
 * a pre-bind output placeholder's produced/published state, and a command
 * node's assembled context content (for the "beyond the model's window"
 * check). Sparse — most nodes carry neither.
 */
export interface WarningFacts {
  readonly producedOutput?: boolean;
  readonly published?: boolean;
  readonly assembledContent?: string;
}

/** A context edge (spec §3.5): assembly order into the command/session it targets. */
export interface ContextEdgeFact {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly ordinal: number;
}

export interface GraphSnapshot {
  readonly nodes: readonly CanvasNodeInput[];
  readonly edges: readonly CanvasEdgeInput[];
  readonly containers: readonly CanvasContainerInput[];
  readonly warningFacts: ReadonlyMap<string, WarningFacts>;
  readonly paletteEntries: readonly PaletteEntry[];
  readonly contextEdges: readonly ContextEdgeFact[];
  /**
   * Every node's *authored* placement (spec §5, §12): `null` means no
   * authored position exists yet, which is what a derived initial
   * arrangement fills in — never a sentinel like `{x:0,y:0}` that could be
   * misread as an authored one. This is the durable-placement seam the
   * server owns; the host reads it to seed and reconcile the canvas's own
   * `placements`, and never needs to fall back to a browser-local store to
   * know where a node last sat (Epic 3.1's deferral, closed by adopting it).
   */
  readonly positions: ReadonlyMap<string, Point | null>;
}

export type Unsubscribe = () => void;

export interface GraphDataSource {
  load(): Promise<GraphSnapshot>;
  /**
   * Live updates after the initial load. Called with a freshly rebuilt
   * snapshot every time something on the board changes; returns a function
   * that stops listening.
   */
  subscribe(onSnapshot: (snapshot: GraphSnapshot) => void): Unsubscribe;
  /**
   * Force a fresh read of `/api/snapshot` into this source's own cached
   * mirror, then notify every subscriber — for the one write this seam
   * cannot learn about any other way: `POST /api/reset` (scope
   * `"arrangement"`) clears authored positions without publishing anything
   * on `/ws` (`apps/server/src/maintenance/reset.ts` — deliberate, a reset
   * touches no bus). Optional so a source with nothing to refresh (fixtures
   * never change) need not implement it; a caller that wants the guarantee
   * checks for it rather than assuming every source has one.
   */
  refresh?(): Promise<void>;
}

/** Stage 1/tests/dev-offline: fixtures behind the same interface the live API implements. */
export function createFixtureGraphDataSource(
  snapshot: GraphSnapshot,
): GraphDataSource {
  return {
    load(): Promise<GraphSnapshot> {
      return Promise.resolve(snapshot);
    },
    subscribe(): Unsubscribe {
      // Fixtures never change; nothing to notify.
      return () => {};
    },
    refresh(): Promise<void> {
      // Fixtures never change; nothing to refresh.
      return Promise.resolve();
    },
  };
}
