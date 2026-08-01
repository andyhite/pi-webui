import type { Author } from "../author.js";
import type { SessionId } from "../ids.js";
import type { ContentDelta, Renderings } from "../renderings.js";
import type { InjectionId } from "./runtime.js";

/**
 * The transcript is content like anything else (§3.6): versioned, wireable as
 * context, with its delta being its new turns. §6.1 adds the bound: a
 * long-running transcript stays within a size budget by releasing the largest
 * old tool outputs first, leaving a visible marker and a way to load the
 * content back. Nothing is silently deleted (principle 12), and an export of a
 * released transcript is complete.
 */

/** Where released content went, so it can be drawn and reloaded (§6.1). */
export interface ReleaseMarker {
  readonly releasedAt: number;
  /** How much was released — the marker states the size it stands in for. */
  readonly bytes: number;
  /**
   * sha256 of the released content. The blob row survives release, so this is
   * the address the content is reloaded from, not a tombstone.
   */
  readonly contentHash: string;
}

export type TranscriptEntry =
  | { readonly kind: "reasoning"; readonly text: string }
  | { readonly kind: "output"; readonly text: string }
  | {
      readonly kind: "tool-call";
      readonly callId: string;
      readonly toolName: string;
      readonly input: string;
    }
  | {
      readonly kind: "tool-result";
      readonly callId: string;
      readonly toolName: string;
      readonly output: string;
      readonly isError: boolean;
      /** Set once the output has been released; the text is then a marker. */
      readonly released: ReleaseMarker | null;
    }
  | {
      /** Injected content arrives as a new turn and stays on the graph (§6.5). */
      readonly kind: "injection";
      readonly injectionId: InjectionId;
      readonly author: Author;
      readonly text: string;
    };

export interface TranscriptTurn {
  /** 1-based, monotonic. The delta between two transcript versions is turns. */
  readonly ordinal: number;
  readonly startedAt: number;
  readonly entries: readonly TranscriptEntry[];
}

export interface Transcript {
  readonly sessionId: SessionId;
  readonly turns: readonly TranscriptTurn[];
}

export function emptyTranscript(sessionId: SessionId): Transcript {
  return { sessionId, turns: [] };
}

export function entryBytes(entry: TranscriptEntry): number {
  switch (entry.kind) {
    case "reasoning":
    case "output":
    case "injection":
      return byteLength(entry.text);
    case "tool-call":
      return byteLength(entry.input);
    case "tool-result":
      return entry.released ? 0 : byteLength(entry.output);
  }
}

export function transcriptBytes(transcript: Transcript): number {
  let total = 0;
  for (const turn of transcript.turns) {
    for (const entry of turn.entries) total += entryBytes(entry);
  }
  return total;
}

/**
 * The global encoder exists in Node and the browser alike, declared here the
 * way `ids.ts` declares `crypto` so this package stays free of platform
 * imports.
 */
declare const TextEncoder: {
  new (): { encode(input: string): { readonly length: number } };
};

function byteLength(text: string): number {
  // Content is stored as UTF-8; counting characters would under-report exactly
  // the tool outputs most worth releasing.
  return new TextEncoder().encode(text).length;
}

/* ---------------------------------------------------------------- renderings */

/** §3.2: every object renders three ways, the transcript included. */
export function transcriptRenderings(transcript: Transcript): Renderings {
  const turns = transcript.turns.length;
  return {
    card: { turns, bytes: transcriptBytes(transcript) },
    summary: `transcript · ${turns} ${turns === 1 ? "turn" : "turns"}`,
    agentContent: renderTurns(transcript.turns),
  };
}

/**
 * §3.2/§3.6: changes arrive as what's new. For a transcript that is exactly
 * its new turns — which is why a per-turn version would bury the drift feed
 * (§4.5) and why the checkpoint rule exists.
 */
export function transcriptDelta(
  previous: Transcript,
  next: Transcript,
): ContentDelta | null {
  const newTurns = next.turns.filter(
    (turn) => turn.ordinal > (previous.turns.at(-1)?.ordinal ?? 0),
  );
  if (newTurns.length === 0) return null;

  return {
    summary: `${newTurns.length} new ${newTurns.length === 1 ? "turn" : "turns"}`,
    body: renderTurns(newTurns),
  };
}

function renderTurns(turns: readonly TranscriptTurn[]): string {
  return turns
    .map(
      (turn) =>
        `## turn ${turn.ordinal}\n${turn.entries.map(renderEntry).join("\n")}`,
    )
    .join("\n\n");
}

function renderEntry(entry: TranscriptEntry): string {
  switch (entry.kind) {
    case "reasoning":
      return `[reasoning] ${entry.text}`;
    case "output":
      return entry.text;
    case "tool-call":
      return `[tool ${entry.toolName}] ${entry.input}`;
    case "tool-result":
      return entry.released
        ? `[tool ${entry.toolName} result released · ${entry.released.bytes} bytes · ${entry.released.contentHash}]`
        : `[tool ${entry.toolName} result] ${entry.output}`;
    case "injection":
      return `[injected by ${entry.author.kind}] ${entry.text}`;
  }
}

/* ------------------------------------------------------------------- release */

export interface ReleaseCandidate {
  readonly turnOrdinal: number;
  readonly callId: string;
  readonly bytes: number;
}

export interface ReleasePlan {
  /** Largest old tool outputs first (§6.1). */
  readonly release: readonly ReleaseCandidate[];
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  /**
   * False when releasing every eligible output still leaves the transcript over
   * budget. The caller warns; it never drops anything else to make the number
   * fit (principle 12).
   */
  readonly withinBudget: boolean;
}

/**
 * Choose what to release. Pure: it decides, it does not mutate, and it never
 * considers reasoning, output, or injected content — releasing what a human
 * said or an agent concluded would be deleting the record, not bounding it.
 *
 * The newest turn is never a candidate: releasing the output a session is
 * still working from is a correctness bug, not a size win.
 */
export function planRelease(
  transcript: Transcript,
  budgetBytes: number,
): ReleasePlan {
  const bytesBefore = transcriptBytes(transcript);
  const newestOrdinal = transcript.turns.at(-1)?.ordinal ?? 0;

  const candidates: ReleaseCandidate[] = [];
  for (const turn of transcript.turns) {
    if (turn.ordinal === newestOrdinal) continue;
    for (const entry of turn.entries) {
      if (entry.kind !== "tool-result" || entry.released) continue;
      candidates.push({
        turnOrdinal: turn.ordinal,
        callId: entry.callId,
        bytes: entryBytes(entry),
      });
    }
  }

  candidates.sort((a, b) => b.bytes - a.bytes || a.turnOrdinal - b.turnOrdinal);

  const release: ReleaseCandidate[] = [];
  let bytesAfter = bytesBefore;
  for (const candidate of candidates) {
    if (bytesAfter <= budgetBytes) break;
    release.push(candidate);
    bytesAfter -= candidate.bytes;
  }

  return {
    release,
    bytesBefore,
    bytesAfter,
    withinBudget: bytesAfter <= budgetBytes,
  };
}

/**
 * Apply a plan, leaving a marker per released output. The caller supplies the
 * content hash it stored the bytes under — release moves content out of the
 * transcript, it does not destroy it.
 */
export function applyRelease(
  transcript: Transcript,
  plan: ReleasePlan,
  at: number,
  hashOf: (callId: string) => string,
): Transcript {
  const releasing = new Set(plan.release.map((candidate) => candidate.callId));
  if (releasing.size === 0) return transcript;

  return {
    ...transcript,
    turns: transcript.turns.map((turn) => ({
      ...turn,
      entries: turn.entries.map((entry) => {
        if (entry.kind !== "tool-result") return entry;
        if (!releasing.has(entry.callId) || entry.released) return entry;
        return {
          ...entry,
          released: {
            releasedAt: at,
            bytes: entryBytes(entry),
            contentHash: hashOf(entry.callId),
          },
          output: "",
        };
      }),
    })),
  };
}

/** Load released content back into the transcript (§6.1). */
export function restoreReleased(
  transcript: Transcript,
  callId: string,
  content: string,
): Transcript {
  return {
    ...transcript,
    turns: transcript.turns.map((turn) => ({
      ...turn,
      entries: turn.entries.map((entry) =>
        entry.kind === "tool-result" &&
        entry.callId === callId &&
        entry.released
          ? { ...entry, output: content, released: null }
          : entry,
      ),
    })),
  };
}

export function releasedMarkers(
  transcript: Transcript,
): readonly { readonly callId: string; readonly marker: ReleaseMarker }[] {
  const markers: { callId: string; marker: ReleaseMarker }[] = [];
  for (const turn of transcript.turns) {
    for (const entry of turn.entries) {
      if (entry.kind === "tool-result" && entry.released) {
        markers.push({ callId: entry.callId, marker: entry.released });
      }
    }
  }
  return markers;
}

/* -------------------------------------------------------------------- export */

export interface TranscriptExport {
  readonly document: string;
  /**
   * §6.1: "an export of a released transcript is complete". False means the
   * store could not rehydrate something — reported, never papered over
   * (principle 12).
   */
  readonly complete: boolean;
  readonly unavailable: readonly string[];
}

/**
 * Export to a portable document. Released content is reloaded first, so what
 * leaves the product is the whole session — the size bound is a storage
 * decision, not an edit to the record.
 */
export function exportTranscript(
  transcript: Transcript,
  loadReleased: (marker: ReleaseMarker, callId: string) => string | null,
): TranscriptExport {
  const unavailable: string[] = [];

  const rehydrated: Transcript = {
    ...transcript,
    turns: transcript.turns.map((turn) => ({
      ...turn,
      entries: turn.entries.map((entry) => {
        if (entry.kind !== "tool-result" || !entry.released) return entry;
        const content = loadReleased(entry.released, entry.callId);
        if (content === null) {
          unavailable.push(entry.callId);
          return entry;
        }
        return { ...entry, output: content, released: null };
      }),
    })),
  };

  return {
    document: renderTurns(rehydrated.turns),
    complete: unavailable.length === 0,
    unavailable,
  };
}
