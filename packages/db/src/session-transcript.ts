import {
  epochSeconds,
  type Author,
  type RuntimeObservation,
  type SessionId,
  type Transcript,
  type TranscriptEntry,
  type TranscriptTurn,
} from "@plotroom/core";

/**
 * The transcript as a projection of the observation log (§3.6).
 *
 * The transcript is content, and its content is what the session was observed
 * to do — so it is derived here rather than written twice. Storing turns
 * separately from the observations they came from would create two records that
 * can disagree about what was said; there is one, and this is the read of it.
 *
 * It lives beside the store that persists the log rather than in
 * `@plotroom/core/sessions` because that subtree has one writer (the
 * development plan's track table) and this is a storage-side read. The *rules*
 * — the checkpoint rule, the release plan, the three renderings — stay there
 * and are called, never restated.
 */

/**
 * What was delivered into a session, looked up from the ledger (§6.5).
 *
 * `origin` is what decides the entry kind: authored steering is somebody's
 * intent and renders as an `injection` with its author; PlotRoom's own report on
 * a failed submission is proof, not intent, and renders as `feedback` — the
 * distinction `@plotroom/core`'s entry kinds already draw, and the reason an
 * unauthored injection needs no invented author to appear at all.
 */
export interface DeliveredInjection {
  readonly origin: "steering" | "condition-feedback";
  /** Present for steering; null for feedback, which nobody authored. */
  readonly author: Author | null;
  readonly text: string;
  /** The declared conditions a piece of feedback is about (§3.5). */
  readonly failedConditionIds: readonly string[];
}

export interface TranscriptFromObservations {
  readonly transcript: Transcript;
  /** Turns observed as *finished*; what the checkpoint rule publishes through. */
  readonly completedTurns: number;
}

/**
 * Fold the log into turns. Consecutive reasoning or output deltas coalesce into
 * one entry — the stream's chunking is a transport detail, and a transcript
 * that preserved it would render one word per line.
 */
export function transcriptFromObservations(
  sessionId: SessionId,
  observations: readonly RuntimeObservation[],
  injections: ReadonlyMap<string, DeliveredInjection> = new Map(),
): TranscriptFromObservations {
  const turns: TranscriptTurn[] = [];
  const toolNames = new Map<string, string>();
  let completedTurns = 0;

  const openTurn = (at: number, ordinal?: number): TranscriptTurn => {
    const turn: TranscriptTurn = {
      ordinal: ordinal ?? turns.length + 1,
      startedAt: epochSeconds(at),
      entries: [],
    };
    turns.push(turn);
    return turn;
  };

  /** Entries can only arrive inside a turn; one is opened if none is. */
  const currentTurn = (at: number): TranscriptTurn =>
    turns.at(-1) ?? openTurn(at);

  const append = (at: number, entry: TranscriptEntry): void => {
    const turn = currentTurn(at);
    (turn.entries as TranscriptEntry[]).push(entry);
  };

  const appendText = (
    at: number,
    kind: "reasoning" | "output",
    text: string,
  ): void => {
    const turn = currentTurn(at);
    const last = turn.entries.at(-1);
    if (last && last.kind === kind) {
      (turn.entries as TranscriptEntry[])[turn.entries.length - 1] = {
        kind,
        text: last.text + text,
      };
      return;
    }
    (turn.entries as TranscriptEntry[]).push({ kind, text });
  };

  for (const observation of observations) {
    switch (observation.kind) {
      case "turn-started":
        openTurn(observation.at, observation.turn);
        break;
      case "reasoning-delta":
        appendText(observation.at, "reasoning", observation.text);
        break;
      case "output-delta":
        appendText(observation.at, "output", observation.text);
        break;
      case "tool-started":
        toolNames.set(observation.callId, observation.toolName);
        append(observation.at, {
          kind: "tool-call",
          callId: observation.callId,
          toolName: observation.toolName,
          input: stringify(observation.input),
        });
        break;
      case "tool-finished":
        append(observation.at, {
          kind: "tool-result",
          callId: observation.callId,
          toolName: toolNames.get(observation.callId) ?? "unknown",
          output: stringify(observation.output),
          isError: observation.isError,
          released: null,
        });
        break;
      case "injection-delivered": {
        const injected = injections.get(observation.injectionId);
        if (!injected) break;

        // Feedback is its own entry kind, so the loop §3.5 describes is visible
        // in the transcript: the session kept going *because* PlotRoom told it
        // which declared conditions were false. Rendering it as an injection
        // would have needed an author it does not have.
        if (injected.origin === "condition-feedback") {
          append(observation.at, {
            kind: "feedback",
            source: "world-condition",
            text: injected.text,
            failedConditionIds: injected.failedConditionIds,
          });
          break;
        }

        if (injected.author === null) break;

        append(observation.at, {
          kind: "injection",
          injectionId: observation.injectionId,
          author: injected.author,
          text: injected.text,
        });
        break;
      }
      case "turn-ended":
        completedTurns = Math.max(completedTurns, observation.turn);
        break;
      case "compaction-started":
      case "compaction-finished":
      case "request-raised":
      case "request-settled":
      case "session-ended":
      case "runtime-error":
        // Observed and stored, but not part of what was *said*: phases, health,
        // and end states read them from the log directly.
        break;
    }
  }

  return { transcript: { sessionId, turns }, completedTurns };
}

/** Tool input and output are arbitrary JSON; the transcript stores text. */
function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
