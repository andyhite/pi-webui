import type { Author } from "../author.js";
import type { SessionId, WorkstreamId } from "../ids.js";
import type { ClaimId, ClaimPolicyId, ClaimWaitId } from "./ids.js";
import type { ClaimPolicy } from "./policy.js";
import { isWithin, pathDepth, type ClaimPath } from "./paths.js";

/**
 * The claim model (§3.4): "Write access to a workspace is granted **per path**.
 * A session claims a file or directory, writes inside it until it yields, and
 * while a path is claimed no other session may claim it."
 *
 * One mechanism, no second concept:
 *
 * - Every claim is a **subdivision of a claim someone already holds**, so claims
 *   form a tree by `grantedFromClaimId`, rooted at the workstream's root claim.
 * - The root claim is held by the **operator**, who is an implicit holder of
 *   everything (§3.4). That is what makes principle 1 hold rather than merely
 *   look held: every claim downstream is a subdivision of a human's grant, so a
 *   chain can only ever redistribute reach it was given, never create any.
 * - The single-writer default is the same mechanism with one grant: the first
 *   session takes the root *path* from the operator's root claim and writes
 *   everywhere. There is no special case for it.
 *
 * The holder is an {@link Author} rather than a claims-only union, because the
 * operator-vs-session distinction here is exactly the one attribution already
 * makes everywhere else (§15 invariant 2).
 */

export interface Claim {
  readonly id: ClaimId;
  readonly workstreamId: WorkstreamId;
  readonly path: ClaimPath;
  readonly holder: Author;
  /** The claim this one subdivides. Null only for the workstream's root claim. */
  readonly grantedFromClaimId: ClaimId | null;
  /**
   * Who authorized it: the granting claim's holder normally, `human` when the
   * operator granted or overrode. Recorded so an audit can tell a policy grant
   * from an operator's intervention.
   */
  readonly grantedBy: Author;
  readonly grantedAt: number;
  /** Renewed by activity; the lease is measured from here (§3.4). */
  readonly lastActivityAt: number;
  /**
   * Seconds of inactivity after which the lease lapses. Null never expires, and
   * **only the operator's root claim may be null**: a lease on the human's own
   * authority would expire the ability to grant anything, while a session claim
   * with no lease is a lock nobody but the operator can break — which is not
   * something §3.4 has a concept for. `violatesLeasePolicy` is the assertion.
   */
  readonly leaseSeconds: number | null;
}

/**
 * A place in a waitlist (§3.4): "later claimants join a visible waitlist."
 *
 * Visible means addressable: this is a record with an id, a position derivable
 * from `since`, and a reason — the data §7.2's blocked-on accounting needs. A
 * waitlist nobody can see is a new invisible stall.
 *
 * A wait has **two independent gates**, because the two questions are
 * independent: is the path *available* (`blockedByClaimIds`), and is this session
 * *authorized* to take it (`authorizedAt`)? A pre-granted policy settles
 * authorization at request time, so a waiter behind a policy-allowed path is
 * granted the instant it frees — which is what makes the waitlist a promise
 * rather than a queue for a second approval. Absent a policy, §6.6's approval is
 * raised immediately, in parallel with the wait, rather than after it.
 *
 * Only sessions wait. The operator never does: they hold everything implicitly
 * and force-release when a holder is wedged.
 */
export interface ClaimWait {
  readonly id: ClaimWaitId;
  readonly workstreamId: WorkstreamId;
  readonly sessionId: SessionId;
  readonly path: ClaimPath;
  readonly since: number;
  /** Live claims held by other sessions at or under the path. Empty = available. */
  readonly blockedByClaimIds: readonly ClaimId[];
  /** The claim whose holder authorizes this — the authority the grant will come from. */
  readonly grantorClaimId: ClaimId | null;
  /** When authorization was settled: by policy at request time, or by an answer. */
  readonly authorizedAt: number | null;
  /**
   * The lease the requester asked for, or **null for "unspecified"** — which the
   * grant resolves to the default lease, exactly as an immediate grant does.
   * Null here has never meant "never expires": that reading is what let a claim
   * granted off the waitlist become immortal.
   */
  readonly requestedLeaseSeconds: number | null;
}

export const CLAIM_WAIT_REASONS = [
  /** Authorized already; someone else holds the path, or part of it. Clears on its own. */
  "held",
  /** No standing policy covers it, so a holder must answer (§6.6). */
  "approval",
] as const;

export type ClaimWaitReason = (typeof CLAIM_WAIT_REASONS)[number];

/**
 * What a waiter is waiting for, derived rather than stored: an approval nobody
 * has answered outranks a held path, because that is the one a human can clear.
 */
export function claimWaitReason(wait: ClaimWait): ClaimWaitReason {
  return wait.authorizedAt === null ? "approval" : "held";
}

/**
 * Everything the manager decides from, and the whole of what Track A persists.
 * Deliberately not a class: state in, decisions out, so the API, the canvas, and
 * an agent tool reach identical verdicts from identical rows (principle 8).
 */
export interface ClaimState {
  readonly workstreamId: WorkstreamId;
  readonly claims: readonly Claim[];
  readonly waits: readonly ClaimWait[];
  readonly policies: readonly ClaimPolicy[];
}

export const CLAIM_RELEASE_REASONS = [
  "yielded",
  "expired",
  "session-ended",
  "force-released",
  "revoked",
] as const;

export type ClaimReleaseReason = (typeof CLAIM_RELEASE_REASONS)[number];

/**
 * What changed, as a list Track A applies to storage and publishes on the state
 * stream. The manager returns effects rather than diffs so persistence never has
 * to re-derive intent from before/after rows — a release and an expiry are
 * different events even when the row change is identical.
 */
export type ClaimEffect =
  | { readonly kind: "claim-granted"; readonly claim: Claim }
  | {
      readonly kind: "claim-released";
      readonly claimId: ClaimId;
      readonly holder: Author;
      readonly reason: ClaimReleaseReason;
      readonly at: number;
    }
  /** A sub-claim outlived its grantor and now hangs from the grantor's own grantor. */
  | {
      readonly kind: "claim-reattached";
      readonly claimId: ClaimId;
      readonly grantedFromClaimId: ClaimId;
    }
  | {
      readonly kind: "claim-renewed";
      readonly claimId: ClaimId;
      readonly lastActivityAt: number;
    }
  | { readonly kind: "wait-added"; readonly wait: ClaimWait }
  | {
      readonly kind: "wait-updated";
      readonly wait: ClaimWait;
    }
  | {
      readonly kind: "wait-removed";
      readonly waitId: ClaimWaitId;
      readonly reason:
        | "granted"
        | "withdrawn"
        | "session-ended"
        | "refused"
        /** Keeping it would deadlock; the `deadlock-refused` effect says how. */
        | "deadlock";
    }
  /**
   * A standing wait was refused because the wait-for graph had closed a cycle
   * around it — the churn case, where a promotion moved a blocker set rather than
   * a request closing the loop (§3.4). Carries the actionable message the session
   * needs, and is always followed by the `wait-removed` that takes the row out.
   */
  | {
      readonly kind: "deadlock-refused";
      readonly wait: ClaimWait;
      readonly message: string;
      readonly cycle: readonly {
        readonly from: SessionId;
        readonly to: SessionId;
        readonly path: string;
      }[];
    }
  /**
   * A claim request outside every standing policy: PlotRoom raises an approval
   * against the grantor (§6.6). The wait stays until it is answered.
   */
  | {
      readonly kind: "approval-required";
      readonly wait: ClaimWait;
      readonly grantorClaimId: ClaimId;
      readonly grantor: Author;
    }
  | { readonly kind: "policy-declared"; readonly policy: ClaimPolicy }
  | {
      readonly kind: "policy-withdrawn";
      readonly policyId: ClaimPolicyId;
      readonly reason: "withdrawn" | "claim-released";
    };

export const CLAIM_REFUSAL_REASONS = [
  /** The path could not be canonicalized (see `PathRefusal`). */
  "invalid_path",
  "no_such_claim",
  "no_such_wait",
  /** The caller is neither the holder nor the operator. */
  "not_holder",
  /** A grant, or a policy, wider than what the granter holds (principle 1). */
  "exceeds_grant",
  "policy_denied",
  /** Granting would close a wait-for cycle (§3.4). */
  "would_deadlock",
  /** Only the operator may do this — the escape hatch is theirs alone. */
  "human_only",
  /** The path is held by someone else; the operator force-releases, never stomps. */
  "already_held",
  /** The root claim is the human's authority; it is not yieldable or releasable. */
  "root_claim_immutable",
] as const;

export type ClaimRefusalReason = (typeof CLAIM_REFUSAL_REASONS)[number];

export interface ClaimRefusal {
  readonly reason: ClaimRefusalReason;
  /** Actionable, per §3.4: it names what the caller holds and what to do next. */
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export type ClaimOutcome<T> =
  | {
      readonly ok: true;
      readonly state: ClaimState;
      readonly effects: readonly ClaimEffect[];
      readonly result: T;
    }
  | { readonly ok: false; readonly refusal: ClaimRefusal };

/* ------------------------------------------------------------------ queries */

export function rootClaimOf(state: ClaimState): Claim | undefined {
  return state.claims.find((claim) => claim.grantedFromClaimId === null);
}

export function claimById(state: ClaimState, id: ClaimId): Claim | undefined {
  return state.claims.find((claim) => claim.id === id);
}

export function isHeldBy(claim: Claim, holder: Author): boolean {
  if (claim.holder.kind === "human") return holder.kind === "human";
  return (
    holder.kind === "session" && holder.sessionId === claim.holder.sessionId
  );
}

export function claimsHeldBy(
  state: ClaimState,
  holder: Author,
): readonly Claim[] {
  return state.claims.filter((claim) => isHeldBy(claim, holder));
}

/**
 * The authority for a path: the deepest claim covering it.
 *
 * This is grant authority "following the path hierarchy, not lineage" (§3.4) as
 * a single expression — whoever holds the nearest enclosing path is who may grant
 * inside it, whatever the lineage between them. Two unrelated sessions both
 * resolve to the root holder with no special case.
 *
 * It answers the write question too, because they are the same question: the
 * deepest covering claim is both who may grant inside the path and who may write
 * it. Two names for one lookup would be two places to get it wrong.
 *
 * Two claims can cover a path at the *same* depth — the single-writer default is
 * exactly that, a session's claim on the root path subdividing the operator's
 * root claim. The deeper one in the *grant* tree wins: a subdivision supersedes
 * what it subdivided, whatever the paths happen to spell.
 */
export function authorityFor(
  state: ClaimState,
  path: ClaimPath,
  excluding: ReadonlySet<ClaimId> = new Set(),
): Claim | undefined {
  let best: Claim | undefined;
  let bestRank: readonly [number, number] = [-1, -1];
  for (const claim of state.claims) {
    if (excluding.has(claim.id)) continue;
    if (!isWithin(path, claim.path)) continue;
    const rank: readonly [number, number] = [
      pathDepth(claim.path),
      grantChainOf(state, claim.id).length,
    ];
    if (
      rank[0] > bestRank[0] ||
      (rank[0] === bestRank[0] && rank[1] > bestRank[1])
    ) {
      best = claim;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Claims that block a request: held by *another session*, at or under the path.
 *
 * Two exclusions carry the model. A claim that merely *encloses* the path is the
 * authority to grant it, not contention. And the **operator never blocks** —
 * they hold everything implicitly (§3.4), which is what every session claim
 * subdivides; a human taking a path back is force-release or a hand edit, not a
 * queue.
 */
export function blockingClaims(
  state: ClaimState,
  path: ClaimPath,
  requester: Author,
): readonly Claim[] {
  return state.claims.filter(
    (claim) =>
      claim.holder.kind === "session" &&
      !isHeldBy(claim, requester) &&
      isWithin(claim.path, path),
  );
}

/** The grant chain from a claim up to the root claim, the claim itself first. */
export function grantChainOf(
  state: ClaimState,
  claimId: ClaimId,
): readonly Claim[] {
  const chain: Claim[] = [];
  const seen = new Set<ClaimId>();
  let current = claimById(state, claimId);
  while (current && !seen.has(current.id)) {
    chain.push(current);
    seen.add(current.id);
    current =
      current.grantedFromClaimId === null
        ? undefined
        : claimById(state, current.grantedFromClaimId);
  }
  return chain;
}

/** Claims granted directly from this one. */
export function subClaimsOf(
  state: ClaimState,
  claimId: ClaimId,
): readonly Claim[] {
  return state.claims.filter((claim) => claim.grantedFromClaimId === claimId);
}

export function leaseExpiresAt(claim: Claim): number | null {
  return claim.leaseSeconds === null
    ? null
    : claim.lastActivityAt + claim.leaseSeconds;
}

export function isExpired(claim: Claim, now: number): boolean {
  const expiresAt = leaseExpiresAt(claim);
  return expiresAt !== null && expiresAt <= now;
}

/**
 * The capability invariant, as a predicate: a claim may not exceed the extent of
 * the claim it subdivides.
 *
 * "A claim can only be granted from capability the granter already holds. A
 * claim redistributes write access within a chain; it never creates any" (§3.4,
 * consistent with principle 1). Asserted at every grant and re-asserted over
 * whole states in the invariant tests.
 */
export function checkGrantExtent(
  granter: Claim,
  path: ClaimPath,
):
  | { readonly allowed: true }
  | { readonly allowed: false; readonly refusal: ClaimRefusal } {
  if (isWithin(path, granter.path)) return { allowed: true };
  return {
    allowed: false,
    refusal: {
      reason: "exceeds_grant",
      message: `a claim cannot exceed what its granter holds: ${path.display} is outside ${granter.path.display || "."}`,
      details: {
        granterClaimId: granter.id,
        granterPath: granter.path.display,
      },
    },
  };
}

/**
 * §3.4: "claims are leases, not locks." Every claim except the operator's root
 * claim carries one, so a wedged holder always frees its paths eventually and
 * force-release stays the fast path rather than the only path.
 */
export function violatesLeasePolicy(state: ClaimState): readonly Claim[] {
  return state.claims.filter((claim) => {
    const isRoot = claim.grantedFromClaimId === null;
    return isRoot ? claim.leaseSeconds !== null : claim.leaseSeconds === null;
  });
}

/** Every claim's extent is inside its granter's. The one invariant that must never break. */
export function violatesGrantExtent(state: ClaimState): readonly Claim[] {
  return state.claims.filter((claim) => {
    if (claim.grantedFromClaimId === null) return false;
    const granter = claimById(state, claim.grantedFromClaimId);
    if (granter === undefined) return true;
    return !isWithin(claim.path, granter.path);
  });
}

/**
 * One writer per path (principle 4), as a check over a whole state.
 *
 * The writer of a path is the holder of the deepest claim covering it, so *nested*
 * claims are never ambiguous however they were granted: the deeper one carves its
 * path out of the shallower one's effective extent, which is what subdivision
 * means. Ambiguity is possible in exactly one shape — two claims on the **same**
 * path held by different holders, with neither superseding the other in the grant
 * tree. That is what this returns, and it must always be empty.
 *
 * The single-writer default is the benign case of the same shape: a session's
 * claim on the root path *is* granted from the operator's root claim, so the
 * subdivision supersedes it and `authorityFor` says so.
 */
export function violatesSingleWriter(
  state: ClaimState,
): readonly (readonly [Claim, Claim])[] {
  const pairs: (readonly [Claim, Claim])[] = [];
  for (let i = 0; i < state.claims.length; i += 1) {
    for (let j = i + 1; j < state.claims.length; j += 1) {
      const a = state.claims[i] as Claim;
      const b = state.claims[j] as Claim;
      if (a.path.key !== b.path.key) continue;
      if (isHeldBy(a, b.holder)) continue;
      const supersedes =
        grantChainOf(state, a.id).some((claim) => claim.id === b.id) ||
        grantChainOf(state, b.id).some((claim) => claim.id === a.id);
      if (!supersedes) pairs.push([a, b]);
    }
  }
  return pairs;
}
