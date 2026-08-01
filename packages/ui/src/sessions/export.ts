/**
 * Bridges the async `SessionDataSource.loadReleasedContent` seam onto
 * `@plotroom/core`'s `exportTranscript`, whose `loadReleased` callback is
 * synchronous by design (the store call it wraps in `@plotroom/db` will be
 * synchronous SQLite reads). Every released marker is fetched first, then
 * `exportTranscript` runs over a plain lookup map — the export's own
 * completeness contract (§6.1: "an export of a released transcript is
 * complete") is untouched, just reached over one extra async step.
 */

import type {
  ReleaseMarker,
  Transcript,
  TranscriptExport,
} from "@plotroom/core";
import { exportTranscript, releasedMarkers } from "@plotroom/core";

export async function exportTranscriptAsync(
  transcript: Transcript,
  loadReleased: (
    marker: ReleaseMarker,
    callId: string,
  ) => Promise<string | null>,
): Promise<TranscriptExport> {
  const markers = releasedMarkers(transcript);
  const entries = await Promise.all(
    markers.map(
      async ({ callId, marker }) =>
        [callId, await loadReleased(marker, callId)] as const,
    ),
  );
  const byCallId = new Map(entries);

  return exportTranscript(
    transcript,
    (_marker, callId) => byCallId.get(callId) ?? null,
  );
}

/**
 * The message the Conversation panel renders beside an incomplete export
 * (§6.1, principle 12: the failure path is reported, never papered over by
 * keeping only `result.document`). Pure so the rendering decision is
 * testable without mounting anything — this package has no jsdom/component-
 * test infra, so the logic a render would otherwise embed inline lives here
 * instead.
 */
export function exportIncompleteMessage(
  unavailable: readonly string[],
): string {
  return `export incomplete: could not reload ${unavailable.join(", ")}`;
}
