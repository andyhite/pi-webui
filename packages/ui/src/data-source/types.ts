/**
 * The seam Stage 2 (Sync 2) swaps: the canvas is fed by a `GraphDataSource`,
 * never by fixtures directly. Today the only implementation is
 * `createFixtureGraphDataSource`; once the server API exists, a
 * `createApiGraphDataSource` implementation (over `HttpClient` +
 * `ReconnectingSocket`) lands beside it and the app swaps which one it
 * constructs — nothing that consumes `GraphDataSource` changes.
 */

import type {
  CanvasContainerInput,
  CanvasEdgeInput,
  CanvasNodeInput,
} from "../canvas/PlotCanvas.js";

export interface GraphSnapshot {
  readonly nodes: readonly CanvasNodeInput[];
  readonly edges: readonly CanvasEdgeInput[];
  readonly containers: readonly CanvasContainerInput[];
}

export interface GraphDataSource {
  load(): Promise<GraphSnapshot>;
}

/** Stage 1: fixtures behind the same interface a live API will implement. */
export function createFixtureGraphDataSource(
  snapshot: GraphSnapshot,
): GraphDataSource {
  return {
    load(): Promise<GraphSnapshot> {
      return Promise.resolve(snapshot);
    },
  };
}
