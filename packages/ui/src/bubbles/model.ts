/**
 * Speech bubbles (spec §5, §6.4, §6.5): "a message draws as a bubble on the
 * node that produced it — a command shows the prompt it dispatched, a
 * session shows what it is saying, a tool in flight shows as a distinct
 * chip." Attribution is the point, so every bubble names the sender node it
 * attaches to and nothing else decides that.
 *
 * `BubbleSource` is the input to the placement engine (`placement.ts`) — one
 * entry per thing that could show as a bubble, produced by
 * `derive-sources.ts` from the real streams this track already has
 * (transcript, phase) plus the fixture-fed question/injection seams noted
 * in the landed-note. `wantsAttention` is what the global cap's priority
 * rule (§5: "cap how many show at once") reads; recency (`updatedAt`) is
 * the tie-break underneath it.
 */

export type BubbleKind =
  | "command-prompt"
  | "session-output"
  | "tool-in-flight"
  | "question"
  | "injection";

export type InjectionBubbleStatus = "queued" | "delivered" | "refused";

export interface BubbleSource {
  /** Stable across renders — e.g. `${nodeId}:output`, `${nodeId}:tool:${callId}`. */
  readonly id: string;
  readonly nodeId: string;
  readonly kind: BubbleKind;
  readonly text: string;
  /** Epoch ms; the global cap's recency tie-break reads this (§5). */
  readonly updatedAt: number;
  /** Drives global-cap priority (§5) — a question or a failure wants attention. */
  readonly wantsAttention: boolean;
  /** `kind: "question"` only — selectable options, answerable inline (§6.4). */
  readonly options?: readonly string[];
  /**
   * `kind: "question"` only — the option already picked, if any. Set, not
   * removed: "options not picked remain visible as paths not taken" (§6.4).
   */
  readonly answeredValue?: string | null;
  /** `kind: "injection"` only — queued vs delivered renders distinctly (§6.5). */
  readonly injectionStatus?: InjectionBubbleStatus;
}
