/**
 * Turns the real streams this track already has into `BubbleSource`s (spec
 * §5): a command's dispatched prompt, a session's latest saying, a tool in
 * flight as its own distinct kind, and an injection's queued/delivered
 * state. Pure — the placement engine (`placement.ts`) never reaches back
 * into `Transcript`/`SessionPhase`/`InjectionLedger` itself, this is the one
 * place those shapes turn into bubble sources.
 *
 * Deliberately *not* here: structured questions. No stream in this codebase
 * carries an open question's text/options yet (`SessionStatus` only exposes
 * the derived phase, not the `RuntimeRequest` behind a `waiting-input`
 * phase) — `question-source.ts`'s fixture-fed `QuestionDataSource` is the
 * seam for that until Track A/C land it; see the landed-note for the exact
 * gap.
 */

import type { InjectionLedger, SessionPhase, Transcript } from "@plotroom/core";
import { injectionStatus } from "@plotroom/core";

import type { BubbleSource } from "./model.js";

export interface CommandBubbleInput {
  readonly nodeId: string;
  /** A command node's assembled context (`WarningFacts.assembledContent`) — the dispatched prompt. */
  readonly assembledContent: string;
  readonly updatedAt: number;
}

/** "a command shows the prompt it dispatched" (§5). */
export function deriveCommandBubbleSources(
  inputs: readonly CommandBubbleInput[],
): readonly BubbleSource[] {
  return inputs
    .filter((input) => input.assembledContent.trim() !== "")
    .map((input) => ({
      id: `${input.nodeId}:command-prompt`,
      nodeId: input.nodeId,
      kind: "command-prompt" as const,
      text: input.assembledContent,
      updatedAt: input.updatedAt,
      wantsAttention: false,
    }));
}

/** Every entry kind that reads as "what the session is saying" (§5) — never a tool call/result. */
function latestSayingText(transcript: Transcript): string | null {
  for (let t = transcript.turns.length - 1; t >= 0; t--) {
    const entries = transcript.turns[t]?.entries ?? [];
    for (let e = entries.length - 1; e >= 0; e--) {
      const entry = entries[e];
      if (entry?.kind === "output" || entry?.kind === "reasoning") {
        return entry.text;
      }
    }
  }
  return null;
}

export interface SessionBubbleInput {
  readonly nodeId: string;
  readonly transcript: Transcript;
  readonly phase: SessionPhase;
  /** Falls back to this when the transcript itself carries no timestamp to read (an empty session). */
  readonly now: number;
}

/**
 * "a session shows what it is saying, a tool in flight shows as a distinct
 * chip" (§5) — up to two sources per session node: the latest saying, and,
 * only while `phase.kind === "tool-running"`, a `tool-in-flight` chip that
 * is its own kind rather than folded into the saying bubble.
 */
export function deriveSessionBubbleSources(
  input: SessionBubbleInput,
): readonly BubbleSource[] {
  const sources: BubbleSource[] = [];
  const saying = latestSayingText(input.transcript);
  if (saying !== null) {
    const lastTurn = input.transcript.turns.at(-1);
    sources.push({
      id: `${input.nodeId}:session-output`,
      nodeId: input.nodeId,
      kind: "session-output",
      text: saying,
      updatedAt: lastTurn?.startedAt ?? input.now,
      wantsAttention: false,
    });
  }

  if (input.phase.kind === "tool-running") {
    sources.push({
      id: `${input.nodeId}:tool:${input.phase.toolName}`,
      nodeId: input.nodeId,
      kind: "tool-in-flight",
      text: input.phase.toolName,
      updatedAt: input.now,
      wantsAttention: false,
    });
  }

  return sources;
}

/**
 * "an injection during a long tool call shows as queued until delivered"
 * (§6.5) — rendered as its own bubble kind so the distinction is structural,
 * not a label inside another bubble's text.
 */
export function deriveInjectionBubbleSources(
  nodeId: string,
  ledger: InjectionLedger,
): readonly BubbleSource[] {
  return [...ledger.values()].map((entry) => {
    const status = injectionStatus(entry);
    return {
      id: `${nodeId}:injection:${entry.id}`,
      nodeId,
      kind: "injection" as const,
      text: entry.text,
      updatedAt: entry.deliveredAt ?? entry.refusedAt ?? entry.queuedAt,
      wantsAttention: false,
      injectionStatus: status,
    };
  });
}
