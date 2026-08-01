import type { EpochMillis } from "./exec.js";
import type { WorkspaceKindName } from "./kind.js";

/**
 * Divergence detection (§3.4) and the continuation gate it feeds (§4.3).
 *
 * "The product can tell when a workspace changed outside a session — a rebase,
 * a merge, moved files — which is what makes it safe or unsafe to continue an
 * earlier session."
 *
 * A fingerprint is a *change detector*, not a copy of the workspace: enough to
 * answer "is this the same line of work the session was looking at?" and
 * nothing more. Comparison is a pure function so the run preview, the API, and
 * agent tools all reach the same verdict.
 */

export interface UnitFingerprint {
  /** Which root this describes; a single-root kind uses one, a composite N (§13). */
  readonly rootKey: string;
  /** The committed point of work: a git commit sha, whatever a kind's is. */
  readonly head: string | null;
  /** The named line of work — a git branch. Null when there is none. */
  readonly branch: string | null;
  readonly upstream: string | null;
  readonly upstreamHead: string | null;
  /** A digest over the uncommitted set, so hand edits are detectable without storing them. */
  readonly dirtyDigest: string;
  readonly dirtyCount: number;
}

export interface WorkspaceFingerprint {
  readonly kind: WorkspaceKindName;
  readonly observedAt: EpochMillis;
  readonly units: readonly UnitFingerprint[];
}

export const DIVERGENCE_KINDS = [
  /** The recorded head is no longer reachable: a rebase, an amend, a force-push. */
  "history-rewritten",
  /** New commits on the same line: someone else's merge, or a terminal commit. */
  "commits-added",
  /** The workspace is on a different branch, or moved on/off detached HEAD. */
  "branch-changed",
  /** The tracking branch moved; the workspace itself did not. */
  "upstream-moved",
  /** The uncommitted set changed — the operator as implicit claim holder (§3.4). */
  "uncommitted-changed",
  /** A root appeared or vanished (composite kinds, §13). */
  "roots-changed",
  /** Compared against a fingerprint from another kind: no verdict is possible. */
  "unknown",
] as const;

export type DivergenceKind = (typeof DIVERGENCE_KINDS)[number];

export interface DivergenceChange {
  readonly rootKey: string;
  readonly kind: DivergenceKind;
  readonly detail: string;
}

export interface DivergenceReport {
  readonly diverged: boolean;
  readonly changes: readonly DivergenceChange[];
  readonly observedAt: EpochMillis;
}

/**
 * What the kind can tell us about the recorded head, per root: is it still an
 * ancestor of where the workspace stands now? Absent means the kind could not
 * say, which is treated as unknown rather than as "fine".
 */
export interface AncestryProbe {
  readonly priorHeadReachable: ReadonlyMap<string, boolean>;
}

const NO_PROBE: AncestryProbe = { priorHeadReachable: new Map() };

export function deriveDivergence(
  before: WorkspaceFingerprint,
  after: WorkspaceFingerprint,
  probe: AncestryProbe = NO_PROBE,
): DivergenceReport {
  const changes: DivergenceChange[] = [];

  if (before.kind !== after.kind) {
    return {
      diverged: true,
      changes: [
        {
          rootKey: "*",
          kind: "unknown",
          detail: `Fingerprint kind changed from ${before.kind} to ${after.kind}.`,
        },
      ],
      observedAt: after.observedAt,
    };
  }

  const beforeUnits = new Map(before.units.map((unit) => [unit.rootKey, unit]));
  const afterUnits = new Map(after.units.map((unit) => [unit.rootKey, unit]));

  for (const unit of after.units) {
    if (!beforeUnits.has(unit.rootKey)) {
      changes.push({
        rootKey: unit.rootKey,
        kind: "roots-changed",
        detail: "Root was added since the recorded fingerprint.",
      });
    }
  }

  for (const priorUnit of before.units) {
    const currentUnit = afterUnits.get(priorUnit.rootKey);
    if (currentUnit === undefined) {
      changes.push({
        rootKey: priorUnit.rootKey,
        kind: "roots-changed",
        detail: "Root is gone since the recorded fingerprint.",
      });
      continue;
    }
    changes.push(...compareUnit(priorUnit, currentUnit, probe));
  }

  return {
    diverged: changes.length > 0,
    changes,
    observedAt: after.observedAt,
  };
}

function compareUnit(
  before: UnitFingerprint,
  after: UnitFingerprint,
  probe: AncestryProbe,
): DivergenceChange[] {
  const changes: DivergenceChange[] = [];
  const rootKey = before.rootKey;

  if (before.branch !== after.branch) {
    changes.push({
      rootKey,
      kind: "branch-changed",
      detail: `Branch went from ${describeBranch(before.branch)} to ${describeBranch(after.branch)}.`,
    });
  }

  if (before.head !== after.head) {
    const reachable = probe.priorHeadReachable.get(rootKey);
    if (reachable === false) {
      changes.push({
        rootKey,
        kind: "history-rewritten",
        detail: `The commit the session worked from (${short(before.head)}) is no longer in the history of ${short(after.head)}.`,
      });
    } else if (reachable === true) {
      changes.push({
        rootKey,
        kind: "commits-added",
        detail: `New commits since ${short(before.head)}; now at ${short(after.head)}.`,
      });
    } else {
      changes.push({
        rootKey,
        kind: "unknown",
        detail: `Head moved from ${short(before.head)} to ${short(after.head)}; ancestry could not be checked.`,
      });
    }
  }

  if (
    before.upstream === after.upstream &&
    before.upstreamHead !== after.upstreamHead
  ) {
    changes.push({
      rootKey,
      kind: "upstream-moved",
      detail: `Upstream ${after.upstream ?? "(none)"} moved from ${short(before.upstreamHead)} to ${short(after.upstreamHead)}.`,
    });
  }

  if (before.dirtyDigest !== after.dirtyDigest) {
    changes.push({
      rootKey,
      kind: "uncommitted-changed",
      detail: `Uncommitted changes went from ${before.dirtyCount} to ${after.dirtyCount} path(s).`,
    });
  }

  return changes;
}

/**
 * Which divergences force a fresh session (§4.3).
 *
 * Rewritten history, a switched branch, a changed root set, and an unanswerable
 * comparison all leave a session's mental picture stale "in a way no update can
 * repair". New commits count too: a cross-merge is the spec's own example.
 *
 * Uncommitted changes deliberately do not — the operator is an implicit claim
 * holder and hand edits are their own divergence class (§3.4); staling every
 * session on the first keystroke is the failure that rule exists to prevent.
 * Claim-precise attribution (Epic 4.4) narrows this further.
 */
export function forcesFresh(kind: DivergenceKind): boolean {
  switch (kind) {
    case "history-rewritten":
    case "branch-changed":
    case "commits-added":
    case "roots-changed":
    case "unknown":
      return true;
    case "upstream-moved":
    case "uncommitted-changed":
      return false;
  }
}

export interface ContinuationGate {
  readonly allowed: boolean;
  /** The changes that forced fresh; empty when continuation is allowed. */
  readonly blocking: readonly DivergenceChange[];
  readonly message: string | null;
}

/** The §4.3 gate: workspace divergence forces fresh, and says why. */
export function checkContinuation(report: DivergenceReport): ContinuationGate {
  const blocking = report.changes.filter((change) => forcesFresh(change.kind));
  if (blocking.length === 0) {
    return { allowed: true, blocking: [], message: null };
  }
  return {
    allowed: false,
    blocking,
    message: `The workspace changed outside this session: ${blocking
      .map((change) => change.detail)
      .join(" ")}`,
  };
}

function describeBranch(branch: string | null): string {
  return branch ?? "(detached)";
}

function short(sha: string | null): string {
  if (sha === null) return "(none)";
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

/**
 * A stable digest over the uncommitted set (FNV-1a, 64-bit, as two 32-bit
 * halves). It answers "did this change?" and nothing else — no platform crypto
 * import, and no claim of being a secure hash.
 */
export function digestPaths(paths: readonly string[]): string {
  const sorted = [...paths].sort();
  let hashA = 0x811c9dc5;
  let hashB = 0x01000193;
  for (const path of sorted) {
    for (let index = 0; index < path.length; index += 1) {
      const code = path.charCodeAt(index);
      hashA = Math.imul(hashA ^ code, 0x01000193) >>> 0;
      hashB = Math.imul(hashB + code + index, 0x85ebca6b) >>> 0;
    }
    hashA = Math.imul(hashA ^ 0x0a, 0x01000193) >>> 0;
  }
  return `${hashA.toString(16).padStart(8, "0")}${hashB.toString(16).padStart(8, "0")}`;
}
