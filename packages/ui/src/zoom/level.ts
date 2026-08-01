/**
 * Zoom-level semantics (spec §5): zoomed out renders one card per
 * workstream, mid-zoom renders the nodes inside, zoomed in renders full
 * detail. This is a pure mapping from a viewport zoom scale to a level; the
 * canvas reads xyflow's viewport zoom and switches node renderers by it.
 */

export type ZoomLevel = "workstream" | "inner" | "detail";

export interface ZoomThresholds {
  /** Zoom at and above which containers open to show their inner nodes. */
  readonly inner: number;
  /** Zoom at and above which inner nodes render full detail. */
  readonly detail: number;
}

export const DEFAULT_ZOOM_THRESHOLDS: ZoomThresholds = {
  inner: 0.6,
  detail: 1.2,
};

/** Pure: a zoom scale plus thresholds, nothing else, determines the level. */
export function zoomLevelForScale(
  zoom: number,
  thresholds: ZoomThresholds = DEFAULT_ZOOM_THRESHOLDS,
): ZoomLevel {
  if (zoom >= thresholds.detail) return "detail";
  if (zoom >= thresholds.inner) return "inner";
  return "workstream";
}
