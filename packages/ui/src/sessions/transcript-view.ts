/**
 * Conversation panel rendering logic (spec §6.1): reasoning rendered
 * distinctly from output, and a tool call paired with its result (once
 * observed) as one collapsible unit. Pure and synchronous — the panel
 * component only maps this over JSX; every partitioning decision is made
 * and tested here, not inline in the component.
 *
 * Deliberately does not reimplement anything `@plotroom/core`'s
 * `transcript.ts` already states: release markers stay exactly the shape
 * `releasedMarkers`/`ReleaseMarker` define, and turn ordering/bytes are
 * read off `Transcript` as-is.
 */

import type { Author, ReleaseMarker, Transcript } from "@plotroom/core";

export type TranscriptViewItem =
  | { readonly kind: "reasoning"; readonly text: string }
  | { readonly kind: "output"; readonly text: string }
  | {
      readonly kind: "injection";
      readonly author: Author;
      readonly text: string;
    }
  | {
      readonly kind: "tool-call";
      readonly callId: string;
      readonly toolName: string;
      readonly input: string;
      /** Null while the call is still running — no result observed yet. */
      readonly result: {
        readonly output: string;
        readonly isError: boolean;
        readonly released: ReleaseMarker | null;
      } | null;
    };

export interface TranscriptViewTurn {
  readonly ordinal: number;
  readonly startedAt: number;
  readonly items: readonly TranscriptViewItem[];
}

/**
 * Partitions one turn's entries into view items, pairing each tool call
 * with its result by `callId` within the same turn (a result observed
 * outside its call's turn is defensively treated as its own orphaned
 * item — never dropped, per principle 12).
 */
function buildTurnItems(
  entries: Transcript["turns"][number]["entries"],
): readonly TranscriptViewItem[] {
  const items: TranscriptViewItem[] = [];
  const callIndexById = new Map<string, number>();

  for (const entry of entries) {
    switch (entry.kind) {
      case "reasoning":
        items.push({ kind: "reasoning", text: entry.text });
        break;
      case "output":
        items.push({ kind: "output", text: entry.text });
        break;
      case "injection":
        items.push({
          kind: "injection",
          author: entry.author,
          text: entry.text,
        });
        break;
      case "tool-call":
        callIndexById.set(entry.callId, items.length);
        items.push({
          kind: "tool-call",
          callId: entry.callId,
          toolName: entry.toolName,
          input: entry.input,
          result: null,
        });
        break;
      case "tool-result": {
        const index = callIndexById.get(entry.callId);
        const result = {
          output: entry.output,
          isError: entry.isError,
          released: entry.released,
        };
        if (index === undefined) {
          // A result with no matching call in this turn — surface it
          // rather than silently discarding a record (principle 12).
          items.push({
            kind: "tool-call",
            callId: entry.callId,
            toolName: entry.toolName,
            input: "",
            result,
          });
          break;
        }
        const existing = items[index];
        if (existing && existing.kind === "tool-call") {
          items[index] = { ...existing, result };
        }
        break;
      }
    }
  }

  return items;
}

export function buildTranscriptView(
  transcript: Transcript,
): readonly TranscriptViewTurn[] {
  return transcript.turns.map((turn) => ({
    ordinal: turn.ordinal,
    startedAt: turn.startedAt,
    items: buildTurnItems(turn.entries),
  }));
}
