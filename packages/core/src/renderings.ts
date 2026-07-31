import type { ObjectKind } from "./objects.js";

/**
 * Spec §3.2: every object has exactly one output — its content, prepared for
 * agent consumption — and renders three ways. All three are supplied by
 * whatever produced the object, so every surface renders concepts rather than
 * connectors.
 */
export interface Renderings {
  /** Structured data for the card renderer. Kind-specific, JSON-serializable. */
  readonly card: Readonly<Record<string, unknown>>;
  /** One-line compact summary, for collapsed and list surfaces. */
  readonly summary: string;
  /** The object's single output: content prepared for agent consumption. */
  readonly agentContent: string;
}

/**
 * Spec §3.2: "four new review comments arrived" is smaller and more actionable
 * than a re-rendered pull request. Every kind can express a change against an
 * earlier version of itself; where the delta is larger than the content, the
 * full content stands in.
 */
export interface ContentDelta {
  readonly summary: string;
  readonly body: string;
}

/**
 * Producers supply renderings and, where they can, deltas. Returning null from
 * `renderDelta` is the honest answer for kinds that cannot express one; the
 * store then falls back to full content rather than inventing a diff.
 */
export interface ContentProducer<TSource = unknown> {
  readonly kind: ObjectKind;
  render(source: TSource): Renderings;
  renderDelta?(previous: Renderings, next: Renderings): ContentDelta | null;
}

/**
 * The fallback rule, stated once so no producer has to reimplement it: a delta
 * bigger than the content it describes is not worth storing or reading.
 */
export function chooseDelta(
  delta: ContentDelta | null,
  nextContent: string,
): ContentDelta | null {
  if (!delta) return null;
  return delta.body.length < nextContent.length ? delta : null;
}
