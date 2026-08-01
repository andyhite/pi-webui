import type { Author } from "../author.js";
import type { SessionId } from "../ids.js";
import {
  checkContinuation,
  forcesFresh,
  type ContinuationGate,
  type DivergenceChange,
  type DivergenceKind,
  type DivergenceReport,
} from "../workspaces/divergence.js";
import type { ClaimId } from "./ids.js";
import { describePath, pathsConflict, type ClaimPath } from "./paths.js";

/**
 * Claim-precise divergence (§3.4), which the claim model sharpens "for free":
 *
 * "A session's picture is stale if a path it read was written by a different
 * claim holder — not 'the workspace changed somehow' — so continuation is
 * blocked far less often and always for a reason the product can name."
 *
 * And the operator half of it: "a human editing files alongside sessions is the
 * normal case, not an anomaly, so hand edits are a named divergence class of
 * their own — they stale a session only when they touch paths that session read,
 * never wholesale."
 *
 * This narrows Epic 4.3's deliberately conservative verdicts in both directions.
 * `commits-added` stops forcing a fresh session when the ledger can account for
 * every write; hand edits *start* blocking when they touched a path the session
 * read, which the workspace-level fingerprint could never tell. Both depend on
 * the ledger being complete for the interval — when it is not, the conservative
 * answer stands, because inferring from an incomplete record is exactly what
 * principle 7 forbids.
 */

/** One observed write, attributed to whoever held the path (or to the operator). */
export interface PathWrite {
  readonly path: ClaimPath;
  readonly holder: Author;
  /** The claim it was written under; null for the operator's implicit holding. */
  readonly claimId: ClaimId | null;
  readonly at: number;
}

/** One observed read, so staleness can compare against when the session looked. */
export interface PathRead {
  readonly path: ClaimPath;
  readonly at: number;
}

export const CLAIM_STALE_CLASSES = [
  /** Another session, holding the path, wrote it after this session read it. */
  "peer-write",
  /** The operator wrote it by hand — their own class, per §3.4. */
  "hand-edit",
] as const;

export type ClaimStaleClass = (typeof CLAIM_STALE_CLASSES)[number];

export interface ClaimStaleRead {
  readonly readPath: ClaimPath;
  readonly writtenPath: ClaimPath;
  readonly readAt: number;
  readonly writtenAt: number;
  readonly writtenBy: Author;
  readonly staleClass: ClaimStaleClass;
}

/**
 * Which of a session's reads a different holder has since invalidated.
 *
 * Hierarchical, like every other path comparison here: a write to `src/` stales a
 * read of `src/auth.ts`, and a write to `src/auth.ts` stales a read of `src/`.
 * A session's own writes never stale it — it knows what it did.
 */
export function deriveClaimStaleReads(
  sessionId: SessionId,
  reads: readonly PathRead[],
  writes: readonly PathWrite[],
): readonly ClaimStaleRead[] {
  const stale: ClaimStaleRead[] = [];

  for (const read of reads) {
    for (const write of writes) {
      if (
        write.holder.kind === "session" &&
        write.holder.sessionId === sessionId
      ) {
        continue;
      }
      if (write.at <= read.at) continue;
      if (!pathsConflict(write.path, read.path)) continue;
      stale.push({
        readPath: read.path,
        writtenPath: write.path,
        readAt: read.at,
        writtenAt: write.at,
        writtenBy: write.holder,
        staleClass: write.holder.kind === "human" ? "hand-edit" : "peer-write",
      });
    }
  }

  return stale;
}

/**
 * Which workspace-level divergence kinds a write ledger can speak for.
 *
 * `commits-added` and `uncommitted-changed` are changes *to paths*, so an
 * attributed ledger answers them precisely. A rewritten history, a switched
 * branch, a changed root set, and an unanswerable comparison are not about paths
 * at all — no ledger narrows those, and they keep forcing fresh.
 */
export function isPathAttributable(kind: DivergenceKind): boolean {
  return kind === "commits-added" || kind === "uncommitted-changed";
}

export interface ClaimAttribution {
  readonly sessionId: SessionId;
  /**
   * True only when the write ledger covers the whole interval being judged. False
   * (or absent coverage for a root) keeps Epic 4.3's conservative verdict: an
   * incomplete record is not evidence of nothing having happened (principle 7).
   */
  readonly complete: boolean;
  readonly staleReads: readonly ClaimStaleRead[];
}

export interface ClaimContinuationGate extends ContinuationGate {
  /** The reads a different holder invalidated. Empty when continuation is allowed. */
  readonly staleReads: readonly ClaimStaleRead[];
  /** Whether the claim ledger was used, or the conservative rule stood in for it. */
  readonly precise: boolean;
}

/**
 * The §4.3 continuation gate with claims joined in.
 *
 * Without attribution this is exactly {@link checkContinuation}. With a complete
 * ledger, path-attributable changes stop deciding it and the stale-read set does
 * — which is the whole point of claims sharpening divergence: continuation is
 * blocked less often, and always for a reason that names a path and a holder.
 */
export function checkClaimContinuation(
  report: DivergenceReport,
  attribution: ClaimAttribution,
): ClaimContinuationGate {
  const base = checkContinuation(report);

  if (!attribution.complete) {
    return {
      ...base,
      staleReads: attribution.staleReads,
      precise: false,
    };
  }

  const blocking: DivergenceChange[] = report.changes.filter(
    (change) => forcesFresh(change.kind) && !isPathAttributable(change.kind),
  );

  if (blocking.length === 0 && attribution.staleReads.length === 0) {
    return {
      allowed: true,
      blocking: [],
      message: null,
      staleReads: [],
      precise: true,
    };
  }

  return {
    allowed: false,
    blocking,
    message: describeStaleness(blocking, attribution.staleReads),
    staleReads: attribution.staleReads,
    precise: true,
  };
}

function describeStaleness(
  blocking: readonly DivergenceChange[],
  staleReads: readonly ClaimStaleRead[],
): string {
  const parts: string[] = [];
  if (blocking.length > 0) {
    parts.push(
      `The workspace changed outside this session: ${blocking
        .map((change) => change.detail)
        .join(" ")}`,
    );
  }
  for (const stale of staleReads) {
    const who =
      stale.staleClass === "hand-edit"
        ? "edited by hand"
        : `written by session ${stale.writtenBy.kind === "session" ? stale.writtenBy.sessionId : "?"}`;
    parts.push(
      `${describePath(stale.writtenPath)} was ${who} after this session read ${describePath(stale.readPath)}.`,
    );
  }
  return parts.join(" ");
}
