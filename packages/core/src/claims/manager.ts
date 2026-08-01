import type { Author } from "../author.js";
import type { Clock } from "../clock.js";
import type { SessionId, WorkstreamId } from "../ids.js";
import {
  describeDeadlock,
  edgesForWait,
  findAnyWaitCycle,
  findWaitCycle,
  waitForEdges,
  waitsInCycle,
  type WaitEdge,
} from "./deadlock.js";
import type { PathWrite } from "./divergence.js";
import {
  newClaimId,
  newClaimPolicyId,
  newClaimWaitId,
  type ClaimId,
  type ClaimPolicyId,
  type ClaimWaitId,
} from "./ids.js";
import {
  authorityFor,
  blockingClaims,
  checkGrantExtent,
  claimById,
  claimsHeldBy,
  claimWaitReason,
  grantChainOf,
  isExpired,
  isHeldBy,
  leaseExpiresAt,
  rootClaimOf,
  subClaimsOf,
  type Claim,
  type ClaimEffect,
  type ClaimOutcome,
  type ClaimRefusal,
  type ClaimRefusalReason,
  type ClaimReleaseReason,
  type ClaimState,
  type ClaimWait,
  type ClaimWaitReason,
} from "./model.js";
import {
  canonicalizePath,
  describePath,
  isWithin,
  pathsConflict,
  ROOT_PATH,
  samePath,
  type ClaimPath,
} from "./paths.js";
import {
  evaluatePolicies,
  describePolicy,
  MATCH_EVERYTHING,
  type ClaimPolicy,
  type ClaimPolicyEffect,
} from "./policy.js";

/**
 * The claim manager (Epic 4.4, §3.4): pure and deterministic. State goes in,
 * decisions and effects come out, and the same functions answer the canvas, the
 * API, and an agent's `claim_request` tool — "claims are system-managed;
 * sessions get tools to request, yield, and inspect them," and principle 4 says
 * that enforcement is the model's, not a convention's.
 *
 * Time is injected (`clock`) and so are ids, because leases, waitlists, and
 * deadlock ordering are untestable against a real clock and a random id.
 */

/**
 * Lease default, decided: **15 minutes of inactivity.**
 *
 * Long enough that a slow tool call or a paused turn does not lose a path
 * mid-edit; short enough that a wedged holder frees its paths inside one coffee
 * break rather than needing the operator. The operator's force-release remains
 * the answer for anything faster, and renewal is what a still-working holder
 * does (writing renews; so does an explicit `renew`).
 */
export const DEFAULT_CLAIM_LEASE_SECONDS = 15 * 60;

/**
 * Past this, a claim wait is worth an alert of its own (§7.2, "a claim wait past
 * a threshold alerts on its own"). Exposed as data here; the alert itself is
 * Phase 6's to render.
 */
export const CLAIM_WAIT_ALERT_THRESHOLD_SECONDS = 5 * 60;

export interface ClaimIdFactory {
  claim(): ClaimId;
  wait(): ClaimWaitId;
  policy(): ClaimPolicyId;
}

export const systemClaimIds: ClaimIdFactory = {
  claim: newClaimId,
  wait: newClaimWaitId,
  policy: newClaimPolicyId,
};

export interface ClaimManagerOptions {
  /** Unix seconds, like every `created_at` in the schema. */
  readonly clock: Clock;
  readonly ids?: Partial<ClaimIdFactory>;
  readonly defaultLeaseSeconds?: number;
}

export interface ClaimRequest {
  readonly sessionId: SessionId;
  /** Canonicalized here, so the tool layer can pass whatever the agent said. */
  readonly path: string | ClaimPath;
  /**
   * Seconds of inactivity to hold it for. Omitted takes the default lease; there
   * is deliberately no way to ask for a claim that never expires — "claims are
   * leases, not locks" (§3.4), and only the operator's root claim is immortal.
   */
  readonly leaseSeconds?: number;
  /** Overrides the clock, for replaying a persisted request at its own time. */
  readonly at?: number;
}

export type ClaimRequestResult =
  | { readonly kind: "granted"; readonly claim: Claim }
  /** The session already holds a claim covering this path; nothing to do. */
  | { readonly kind: "already-held"; readonly claim: Claim }
  | {
      readonly kind: "waiting";
      readonly wait: ClaimWait;
      readonly position: number;
      readonly blockedBy: readonly Claim[];
    }
  | {
      readonly kind: "approval-required";
      readonly wait: ClaimWait;
      readonly grantor: Author;
      readonly grantorClaimId: ClaimId;
      /** Both gates are reported: an approval can be pending on a held path too. */
      readonly position: number;
      readonly blockedBy: readonly Claim[];
    };

export interface ClaimGrantRequest {
  readonly path: string | ClaimPath;
  readonly to: SessionId;
  /** Must be the operator: only they may grant outside the policy hierarchy. */
  readonly by: Author;
  /** Omitted takes the default lease; a session claim is never immortal (§3.4). */
  readonly leaseSeconds?: number;
  readonly at?: number;
}

export interface ClaimReleaseRequest {
  readonly claimId: ClaimId;
  readonly by: Author;
  readonly at?: number;
}

export interface ClaimForceReleaseRequest extends ClaimReleaseRequest {
  /**
   * Take the sub-claims with it. False (the default) reattaches them to the
   * released claim's own grantor: the capability they were given came from the
   * root grant, and a wedged intermediary is exactly the case force-release
   * exists for — killing its children too would punish the wrong sessions.
   */
  readonly cascade?: boolean;
}

export interface ClaimPolicyDeclaration {
  readonly claimId: ClaimId;
  readonly subtree: string | ClaimPath;
  readonly effect: ClaimPolicyEffect;
  readonly pattern?: string;
  readonly by: Author;
  readonly at?: number;
}

export interface ClaimActivity {
  readonly sessionId: SessionId;
  readonly path: string | ClaimPath;
  readonly at?: number;
}

export interface ClaimWriteRecord {
  readonly actor: Author;
  readonly path: string | ClaimPath;
  readonly at?: number;
}

export type ClaimWriteCheck =
  | {
      readonly allowed: true;
      /** The covering claim. Absent only for the operator writing an unclaimed path. */
      readonly claim: Claim | null;
    }
  | { readonly allowed: false; readonly refusal: ClaimRefusal };

export interface ClaimApprovalAnswer {
  readonly waitId: ClaimWaitId;
  /** The grantor's holder, or the operator overriding it. */
  readonly by: Author;
  readonly decision: "grant" | "deny";
  readonly at?: number;
}

export interface HeldClaimView {
  readonly claim: Claim;
  readonly heldForSeconds: number;
  readonly expiresAt: number | null;
  readonly subGrants: readonly Claim[];
}

export interface ClaimWaitView {
  readonly wait: ClaimWait;
  /** 1-based, among the waits on conflicting paths. Visible state, per §3.4. */
  readonly position: number;
  readonly reason: ClaimWaitReason;
  readonly waitingForSeconds: number;
  readonly blockedBy: readonly Claim[];
  /** Who authorizes, or authorized, this wait. */
  readonly grantor: Author | null;
  readonly pastAlertThreshold: boolean;
}

export interface ClaimInspection {
  readonly workstreamId: WorkstreamId;
  readonly observedAt: number;
  readonly held: readonly HeldClaimView[];
  readonly waiting: readonly ClaimWaitView[];
  /** What everyone else holds — contention is only visible if it is visible. */
  readonly othersHold: readonly Claim[];
  /** The policies that would be consulted for this session's next request. */
  readonly policiesInForce: readonly ClaimPolicy[];
}

export interface ClaimWaitMetric {
  readonly waitId: ClaimWaitId;
  readonly sessionId: SessionId;
  readonly path: ClaimPath;
  readonly reason: ClaimWaitReason;
  readonly waitingForSeconds: number;
  readonly pastAlertThreshold: boolean;
  /** True when the answer must come from the operator (§7.2, "blocked on you"). */
  readonly blockedOnHuman: boolean;
}

export interface OverlappingWait {
  readonly path: ClaimPath;
  readonly sessionIds: readonly SessionId[];
}

export interface ClaimWaitMetrics {
  readonly observedAt: number;
  readonly waits: readonly ClaimWaitMetric[];
  readonly blockedOnHumanSeconds: number;
  readonly blockedOnSessionSeconds: number;
  /** §7.2's intra-workstream "conflict predicted": overlapping waitlisted paths. */
  readonly overlapping: readonly OverlappingWait[];
}

export interface ClaimManager {
  /** A workstream's claims begin as the operator's root claim and nothing else. */
  open(
    workstreamId: WorkstreamId,
    at?: number,
  ): {
    readonly state: ClaimState;
    readonly rootClaim: Claim;
    readonly effects: readonly ClaimEffect[];
  };
  request(
    state: ClaimState,
    request: ClaimRequest,
  ): ClaimOutcome<ClaimRequestResult>;
  answerApproval(
    state: ClaimState,
    answer: ClaimApprovalAnswer,
  ): ClaimOutcome<
    | ClaimRequestResult
    | { readonly kind: "denied"; readonly waitId: ClaimWaitId }
  >;
  grant(
    state: ClaimState,
    request: ClaimGrantRequest,
  ): ClaimOutcome<ClaimRequestResult>;
  yieldClaim(
    state: ClaimState,
    request: ClaimReleaseRequest,
  ): ClaimOutcome<{ readonly released: ClaimId }>;
  forceRelease(
    state: ClaimState,
    request: ClaimForceReleaseRequest,
  ): ClaimOutcome<{ readonly released: readonly ClaimId[] }>;
  withdrawWait(
    state: ClaimState,
    request: { readonly waitId: ClaimWaitId; readonly by: Author },
  ): ClaimOutcome<{ readonly withdrawn: ClaimWaitId }>;
  declarePolicy(
    state: ClaimState,
    declaration: ClaimPolicyDeclaration,
  ): ClaimOutcome<{ readonly policy: ClaimPolicy }>;
  withdrawPolicy(
    state: ClaimState,
    request: { readonly policyId: ClaimPolicyId; readonly by: Author },
  ): ClaimOutcome<{ readonly withdrawn: ClaimPolicyId }>;
  renew(
    state: ClaimState,
    request: ClaimReleaseRequest,
  ): ClaimOutcome<{ readonly claim: Claim }>;
  recordActivity(
    state: ClaimState,
    activity: ClaimActivity,
  ): ClaimOutcome<{ readonly renewed: readonly ClaimId[] }>;
  recordWrite(
    state: ClaimState,
    write: ClaimWriteRecord,
  ): ClaimOutcome<{ readonly write: PathWrite }>;
  /**
   * Lapse-aware: a claim whose lease ran out authorizes nothing, swept or not.
   * `asOf` overrides the clock for replay; omitted, it asks the injected clock.
   */
  checkWrite(
    state: ClaimState,
    actor: Author,
    path: string | ClaimPath,
    asOf?: number,
  ): ClaimWriteCheck;
  expire(
    state: ClaimState,
    at?: number,
  ): ClaimOutcome<{ readonly expired: readonly ClaimId[] }>;
  endSession(
    state: ClaimState,
    sessionId: SessionId,
    at?: number,
  ): ClaimOutcome<{
    readonly released: readonly ClaimId[];
    readonly waitsRemoved: readonly ClaimWaitId[];
  }>;
  inspect(
    state: ClaimState,
    view?: { readonly sessionId?: SessionId; readonly at?: number },
  ): ClaimInspection;
  waitMetrics(
    state: ClaimState,
    options?: { readonly at?: number; readonly thresholdSeconds?: number },
  ): ClaimWaitMetrics;
  /** Is this session waiting on a claim? The §3.6 phase input, so it is derived here. */
  isWaitingOnClaim(state: ClaimState, sessionId: SessionId): boolean;
}

export function createClaimManager(options: ClaimManagerOptions): ClaimManager {
  const clock = options.clock;
  const ids: ClaimIdFactory = { ...systemClaimIds, ...options.ids };
  const defaultLease =
    options.defaultLeaseSeconds ?? DEFAULT_CLAIM_LEASE_SECONDS;

  const now = (at?: number): number => at ?? clock();

  /* ------------------------------------------------------------- internals */

  function resolve(path: string | ClaimPath): ClaimPath | ClaimRefusal {
    if (typeof path !== "string") return path;
    const result = canonicalizePath(path);
    if (result.ok) return result.path;
    return {
      reason: "invalid_path",
      message: result.refusal.message,
      details: {
        input: result.refusal.input,
        pathReason: result.refusal.reason,
      },
    };
  }

  function isRefusal(value: ClaimPath | ClaimRefusal): value is ClaimRefusal {
    return (value as ClaimRefusal).reason !== undefined;
  }

  function refuse<T>(
    reason: ClaimRefusalReason,
    message: string,
    details?: Record<string, unknown>,
  ): ClaimOutcome<T> {
    return {
      ok: false,
      refusal:
        details === undefined
          ? { reason, message }
          : { reason, message, details },
    };
  }

  /** Policies that bind a request resolved to `authority`: the whole grant chain's. */
  function policiesInForce(
    state: ClaimState,
    authority: Claim,
  ): readonly ClaimPolicy[] {
    const chainIds = new Set(
      grantChainOf(state, authority.id).map((claim) => claim.id),
    );
    return state.policies.filter((policy) =>
      chainIds.has(policy.declaredByClaimId),
    );
  }

  /**
   * Availability and authorization are *separate* answers, and every variant that
   * could be granted from carries **both**.
   *
   * `denied` used to carry only the policy, which let `grant` — the operator, who
   * overrides a deny — skip the blocker check and stomp a live holder without so
   * much as a release effect. A variant that hides the blockers is a variant a
   * caller can forget to ask about, so it does not exist any more.
   */
  type Evaluation =
    | { readonly kind: "already-held"; readonly claim: Claim }
    | {
        readonly kind: "denied";
        readonly by: ClaimPolicy;
        /** Held by other sessions at or under the path. Empty means available. */
        readonly blockers: readonly Claim[];
        /** Who would grant it — the deepest enclosing claim that is not a blocker. */
        readonly authority: Claim;
      }
    | { readonly kind: "no-root" }
    | {
        readonly kind: "open";
        readonly blockers: readonly Claim[];
        readonly authority: Claim;
        /** True when a standing policy already allows it (§3.4's pre-grant). */
        readonly authorized: boolean;
        readonly by: ClaimPolicy | null;
      };

  /**
   * The one place the §3.4 rules are applied, so a request, a promotion off the
   * waitlist, and an approval answer cannot disagree:
   *
   * 1. already covered by something this session holds — nothing to grant;
   * 2. **hierarchical conflict** — anything at or under the path held by another
   *    session blocks, whether or not those paths exist yet; a claim that merely
   *    *encloses* the path is the authority, and the operator never blocks;
   * 3. **authority follows the path hierarchy** — the deepest enclosing claim
   *    grants, whatever the lineage between them;
   * 4. **pre-granted policy** decides authorization, deny first; silence means
   *    §6.6's approval.
   *
   * Availability and authorization are answered together but kept apart: a waiter
   * behind a policy-allowed path is already authorized, so freeing the path grants
   * it without a second round trip.
   */
  function evaluate(
    state: ClaimState,
    sessionId: SessionId,
    path: ClaimPath,
  ): Evaluation {
    const root = rootClaimOf(state);
    if (root === undefined) return { kind: "no-root" };

    const holder: Author = { kind: "session", sessionId };

    const own = state.claims
      .filter((claim) => isHeldBy(claim, holder) && isWithin(path, claim.path))
      .sort((a, b) => b.path.segments.length - a.path.segments.length)[0];
    if (own) return { kind: "already-held", claim: own };

    const blockers = blockingClaims(state, path, holder);
    const authority = authorityFor(state, path, {
      excluding: new Set(blockers.map((claim) => claim.id)),
    });
    if (authority === undefined) return { kind: "no-root" };

    const verdict = evaluatePolicies(policiesInForce(state, authority), path);
    if (verdict.kind === "deny") {
      return { kind: "denied", by: verdict.by, blockers, authority };
    }

    return {
      kind: "open",
      blockers,
      authority,
      authorized: verdict.kind === "allow",
      by: verdict.kind === "allow" ? verdict.by : null,
    };
  }

  /**
   * Mint a granted claim. Every claim this makes carries a lease: `undefined`
   * means unspecified and resolves to the default, and there is no value that
   * means "never expires" — the only immortal claim is the root one, built by
   * `open` and by nothing else. A claim granted off the waitlist used to inherit
   * `null` from an unspecified request and become a lock forever.
   */
  function makeClaim(
    state: ClaimState,
    input: {
      readonly path: ClaimPath;
      readonly holder: Author;
      readonly grantedFromClaimId: ClaimId;
      readonly grantedBy: Author;
      readonly at: number;
      readonly leaseSeconds?: number | undefined;
    },
  ): Claim {
    return {
      id: ids.claim(),
      workstreamId: state.workstreamId,
      path: input.path,
      holder: input.holder,
      grantedFromClaimId: input.grantedFromClaimId,
      grantedBy: input.grantedBy,
      grantedAt: input.at,
      lastActivityAt: input.at,
      leaseSeconds: input.leaseSeconds ?? defaultLease,
    };
  }

  /** A wait's unspecified lease (null) is "take the default", never "forever". */
  function waitLeaseSeconds(wait: ClaimWait): number | undefined {
    return wait.requestedLeaseSeconds ?? undefined;
  }

  function sortedWaits(state: ClaimState): readonly ClaimWait[] {
    return [...state.waits].sort(
      (a, b) => a.since - b.since || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  function positionOf(state: ClaimState, wait: ClaimWait): number {
    const ahead = state.waits.filter(
      (other) =>
        other.id !== wait.id &&
        pathsConflict(other.path, wait.path) &&
        (other.since < wait.since ||
          (other.since === wait.since && other.id < wait.id)),
    );
    return ahead.length + 1;
  }

  function blockersOf(state: ClaimState, wait: ClaimWait): readonly Claim[] {
    return wait.blockedByClaimIds
      .map((id) => claimById(state, id))
      .filter((claim): claim is Claim => claim !== undefined);
  }

  /**
   * Grant everything the waitlist now allows, in FIFO order.
   *
   * Run after every release, expiry, session end, grant, and policy declaration:
   * a freed path and a newly declared policy are the two things that can unblock
   * a waiter, and the waitlist is the record of who asked first.
   */
  function promoteWaiters(
    state: ClaimState,
    at: number,
  ): { readonly state: ClaimState; readonly effects: readonly ClaimEffect[] } {
    let current = state;
    const effects: ClaimEffect[] = [];
    let progressed = true;

    while (progressed) {
      progressed = false;
      for (const wait of sortedWaits(current)) {
        const evaluation = evaluate(current, wait.sessionId, wait.path);

        if (evaluation.kind === "no-root") continue;

        if (evaluation.kind === "already-held") {
          current = withoutWait(current, wait.id);
          effects.push({
            kind: "wait-removed",
            waitId: wait.id,
            reason: "granted",
          });
          progressed = true;
          continue;
        }

        // A policy that turned deny while a session waited is an answer, not a
        // silent drop: the wait is removed with a reason the waiter can see.
        if (evaluation.kind === "denied") {
          current = withoutWait(current, wait.id);
          effects.push({
            kind: "wait-removed",
            waitId: wait.id,
            reason: "refused",
          });
          progressed = true;
          continue;
        }

        const authorizedAt =
          wait.authorizedAt ?? (evaluation.authorized ? at : null);

        if (evaluation.blockers.length === 0 && authorizedAt !== null) {
          const claim = makeClaim(current, {
            path: wait.path,
            holder: { kind: "session", sessionId: wait.sessionId },
            grantedFromClaimId: evaluation.authority.id,
            grantedBy: evaluation.authority.holder,
            at,
            leaseSeconds: waitLeaseSeconds(wait),
          });
          current = withoutWait(withClaim(current, claim), wait.id);
          effects.push(
            { kind: "claim-granted", claim },
            { kind: "wait-removed", waitId: wait.id, reason: "granted" },
          );
          progressed = true;
          continue;
        }

        const synced = syncWait(current, wait, evaluation, authorizedAt);
        if (synced) {
          current = synced.state;
          effects.push(...synced.effects);
          progressed = true;
        }
      }
    }

    // Promotion is exactly what closes a cycle with nobody requesting anything:
    // handing a path to one waiter moves another waiter's blocker set onto it.
    // Sweeping here is what makes "deadlock is detected, not endured" true for
    // the churn case and not only at insertion.
    const swept = breakDeadlocks(current);
    return {
      state: swept.state,
      effects: [...effects, ...swept.effects],
    };
  }

  /**
   * Refuse standing wait-for cycles until the graph is acyclic.
   *
   * The **newest** wait in each cycle is the one that goes, matching §3.4's rule
   * for the insertion case ("refuses the newest claim"): whoever asked last is
   * who can most cheaply ask again. It leaves with the same actionable message a
   * refused request gets, named from its own perspective — "you hold X, yield one
   * of those" rather than a diagram of the loop.
   */
  function breakDeadlocks(state: ClaimState): {
    readonly state: ClaimState;
    readonly effects: readonly ClaimEffect[];
  } {
    let current = state;
    const effects: ClaimEffect[] = [];

    // Bounded by the number of waits: every pass removes exactly one.
    for (let pass = 0; pass <= state.waits.length; pass += 1) {
      const cycle = findAnyWaitCycle(waitForEdges(current));
      if (cycle === null) break;

      const newest = newestWaitIn(current, cycle);
      if (newest === undefined) break;

      // Re-derive the cycle starting at the wait being refused, so the message
      // names what *that* session holds.
      const others = current.waits
        .filter((wait) => wait.id !== newest.id)
        .flatMap((wait) => edgesForWait(current, wait));
      const fromNewest =
        findWaitCycle(others, edgesForWait(current, newest)) ?? cycle;

      current = withoutWait(current, newest.id);
      effects.push(
        {
          kind: "deadlock-refused",
          wait: newest,
          message: describeDeadlock(fromNewest, current.claims),
          cycle: fromNewest.map((edge) => ({
            from: edge.from,
            to: edge.to,
            path: edge.path.display,
          })),
        },
        { kind: "wait-removed", waitId: newest.id, reason: "deadlock" },
      );
    }

    return { state: current, effects };
  }

  /** Newest by when it joined the queue; the id breaks a tie so this is total. */
  function newestWaitIn(
    state: ClaimState,
    cycle: readonly WaitEdge[],
  ): ClaimWait | undefined {
    const ids = new Set(waitsInCycle(cycle));
    return state.waits
      .filter((wait) => ids.has(wait.id))
      .sort(
        (a, b) => b.since - a.since || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      )[0];
  }

  /**
   * Keep a wait's two gates current, and re-raise the approval only when the
   * *grantor* changed — a released grantor must re-ask, a stable one must not
   * re-ask on every tick.
   */
  function syncWait(
    state: ClaimState,
    wait: ClaimWait,
    evaluation: Extract<Evaluation, { kind: "open" }>,
    authorizedAt: number | null,
  ): {
    readonly state: ClaimState;
    readonly effects: readonly ClaimEffect[];
  } | null {
    const blockedByClaimIds = evaluation.blockers.map((claim) => claim.id);
    const grantorChanged = wait.grantorClaimId !== evaluation.authority.id;
    const blockersChanged =
      blockedByClaimIds.length !== wait.blockedByClaimIds.length ||
      blockedByClaimIds.some(
        (id, index) => wait.blockedByClaimIds[index] !== id,
      );

    if (
      !grantorChanged &&
      !blockersChanged &&
      authorizedAt === wait.authorizedAt
    ) {
      return null;
    }

    const next: ClaimWait = {
      ...wait,
      blockedByClaimIds,
      grantorClaimId: evaluation.authority.id,
      authorizedAt,
    };
    const effects: ClaimEffect[] = [{ kind: "wait-updated", wait: next }];
    if (authorizedAt === null && grantorChanged) {
      effects.push({
        kind: "approval-required",
        wait: next,
        grantorClaimId: evaluation.authority.id,
        grantor: evaluation.authority.holder,
      });
    }
    return {
      state: withWait(withoutWait(state, wait.id), next),
      effects,
    };
  }

  function withClaim(state: ClaimState, claim: Claim): ClaimState {
    return { ...state, claims: [...state.claims, claim] };
  }

  function withWait(state: ClaimState, wait: ClaimWait): ClaimState {
    return { ...state, waits: [...state.waits, wait] };
  }

  function withoutWait(state: ClaimState, waitId: ClaimWaitId): ClaimState {
    return {
      ...state,
      waits: state.waits.filter((wait) => wait.id !== waitId),
    };
  }

  /**
   * Release claims, then heal the grant tree.
   *
   * Sub-claims reattach to the released claim's own grantor rather than dying with
   * it: the capability they hold was subdivided from the root grant, and a parent
   * finishing (or expiring, or being force-released while wedged) does not revoke
   * the human grant it passed along. `cascade` is the operator's explicit "and
   * everything under it too".
   */
  function releaseClaims(
    state: ClaimState,
    seedIds: readonly ClaimId[],
    reason: ClaimReleaseReason,
    at: number,
    cascade: boolean,
  ): {
    readonly state: ClaimState;
    readonly effects: readonly ClaimEffect[];
    readonly released: readonly ClaimId[];
  } {
    const removing = new Set<ClaimId>();
    const queue = [...seedIds];
    while (queue.length > 0) {
      const id = queue.shift() as ClaimId;
      if (removing.has(id)) continue;
      const claim = claimById(state, id);
      if (claim === undefined || claim.grantedFromClaimId === null) continue;
      removing.add(id);
      if (cascade) {
        for (const child of subClaimsOf(state, id)) queue.push(child.id);
      }
    }

    const effects: ClaimEffect[] = [];
    for (const id of removing) {
      const claim = claimById(state, id) as Claim;
      effects.push({
        kind: "claim-released",
        claimId: id,
        holder: claim.holder,
        reason,
        at,
      });
    }

    const surviving: Claim[] = [];
    for (const claim of state.claims) {
      if (removing.has(claim.id)) continue;
      if (
        claim.grantedFromClaimId === null ||
        !removing.has(claim.grantedFromClaimId)
      ) {
        surviving.push(claim);
        continue;
      }
      const grantor = nearestSurvivor(
        state,
        claim.grantedFromClaimId,
        removing,
      );
      surviving.push({ ...claim, grantedFromClaimId: grantor });
      effects.push({
        kind: "claim-reattached",
        claimId: claim.id,
        grantedFromClaimId: grantor,
      });
    }

    const policies = state.policies.filter((policy) => {
      if (!removing.has(policy.declaredByClaimId)) return true;
      effects.push({
        kind: "policy-withdrawn",
        policyId: policy.id,
        reason: "claim-released",
      });
      return false;
    });

    return {
      state: { ...state, claims: surviving, policies },
      effects,
      released: [...removing],
    };
  }

  function nearestSurvivor(
    state: ClaimState,
    from: ClaimId,
    removing: ReadonlySet<ClaimId>,
  ): ClaimId {
    for (const claim of grantChainOf(state, from)) {
      if (!removing.has(claim.id)) return claim.id;
    }
    // Unreachable: the root claim is never releasable, so the walk always finds
    // it. Reported rather than silently mis-parented if it ever becomes reachable.
    throw new Error("claim grant chain has no surviving ancestor");
  }

  function authorizedToRelease(claim: Claim, by: Author): boolean {
    return by.kind === "human" || isHeldBy(claim, by);
  }

  /* -------------------------------------------------------------- operations */

  function open(
    workstreamId: WorkstreamId,
    at?: number,
  ): { state: ClaimState; rootClaim: Claim; effects: readonly ClaimEffect[] } {
    const stamp = now(at);
    const rootClaim: Claim = {
      id: ids.claim(),
      workstreamId,
      path: ROOT_PATH,
      // The operator is an implicit claim holder (§3.4), and the root claim is
      // where every downstream grant's capability comes from (principle 1).
      holder: { kind: "human" },
      grantedFromClaimId: null,
      grantedBy: { kind: "human" },
      grantedAt: stamp,
      lastActivityAt: stamp,
      leaseSeconds: null,
    };
    return {
      state: { workstreamId, claims: [rootClaim], waits: [], policies: [] },
      rootClaim,
      effects: [{ kind: "claim-granted", claim: rootClaim }],
    };
  }

  /**
   * Lapsed leases are swept before anything is granted.
   *
   * `checkWrite` refusing a lapsed holder is not enough on its own: a grant
   * decided against an unswept lapsed claim would leave that row beside the new
   * claim, and two rows on one path is the ambiguity the single-writer invariant
   * exists to forbid. Sweeping first keeps one meaning of "live" — and it also
   * promotes whoever was already waiting, so a newcomer never jumps the queue a
   * lapse just opened.
   *
   * A refusal returns no state, so its sweep is simply not persisted; the next
   * successful operation (or Track A's `expire` tick) does it again.
   */
  function sweepExpired(
    state: ClaimState,
    at: number,
  ): { readonly state: ClaimState; readonly effects: readonly ClaimEffect[] } {
    const outcome = expire(state, at);
    return outcome.ok
      ? { state: outcome.state, effects: outcome.effects }
      : { state, effects: [] };
  }

  function withPriorEffects<T>(
    prior: readonly ClaimEffect[],
    outcome: ClaimOutcome<T>,
  ): ClaimOutcome<T> {
    if (!outcome.ok || prior.length === 0) return outcome;
    return { ...outcome, effects: [...prior, ...outcome.effects] };
  }

  function request(
    state: ClaimState,
    input: ClaimRequest,
  ): ClaimOutcome<ClaimRequestResult> {
    const at = now(input.at);
    const swept = sweepExpired(state, at);
    return withPriorEffects(
      swept.effects,
      requestAgainst(swept.state, { ...input, at }),
    );
  }

  function requestAgainst(
    state: ClaimState,
    input: ClaimRequest,
  ): ClaimOutcome<ClaimRequestResult> {
    const at = now(input.at);
    const path = resolve(input.path);
    if (isRefusal(path)) return { ok: false, refusal: path };

    const evaluation = evaluate(state, input.sessionId, path);

    switch (evaluation.kind) {
      case "no-root":
        return refuse(
          "no_such_claim",
          "this workstream has no root claim; open its claim state first",
        );

      case "already-held": {
        const renewed = renewClaim(state, evaluation.claim, at);
        return {
          ok: true,
          state: renewed.state,
          effects: renewed.effects,
          result: { kind: "already-held", claim: renewed.claim },
        };
      }

      case "denied":
        return refuse(
          "policy_denied",
          `${describePath(path)} is closed by a standing policy (${describePolicy(evaluation.by)}); ask the operator if it should change`,
          {
            policyId: evaluation.by.id,
            subtree: evaluation.by.subtree.display,
          },
        );

      case "open": {
        if (evaluation.blockers.length === 0 && evaluation.authorized) {
          const extent = checkGrantExtent(evaluation.authority, path);
          if (!extent.allowed) return { ok: false, refusal: extent.refusal };
          const claim = makeClaim(state, {
            path,
            holder: { kind: "session", sessionId: input.sessionId },
            grantedFromClaimId: evaluation.authority.id,
            grantedBy: evaluation.authority.holder,
            at,
            leaseSeconds: input.leaseSeconds,
          });
          return {
            ok: true,
            state: withClaim(state, claim),
            effects: [{ kind: "claim-granted", claim }],
            result: { kind: "granted", claim },
          };
        }

        const existing = state.waits.find(
          (wait) =>
            wait.sessionId === input.sessionId && samePath(wait.path, path),
        );
        // One gesture, one thing (principle 9): a retried request returns the
        // place in the queue it already has rather than taking a second one.
        if (existing) {
          return {
            ok: true,
            state,
            effects: [],
            result: waitResult(state, existing),
          };
        }

        const wait: ClaimWait = {
          id: ids.wait(),
          workstreamId: state.workstreamId,
          sessionId: input.sessionId,
          path,
          since: at,
          blockedByClaimIds: evaluation.blockers.map((claim) => claim.id),
          grantorClaimId: evaluation.authority.id,
          // Policy settles authorization now, even while the path is held: the
          // waitlist is a promise, not a queue for a second approval.
          authorizedAt: evaluation.authorized ? at : null,
          requestedLeaseSeconds: input.leaseSeconds ?? null,
        };

        const cycle = findWaitCycle(
          state.waits.flatMap((other) => edgesForWait(state, other)),
          edgesForWait({ ...state, waits: [wait] }, wait),
        );
        if (cycle) {
          // §3.4: the *newest* claim is refused, with a message that names what
          // the requester holds — the thing it can act on.
          return refuse(
            "would_deadlock",
            describeDeadlock(cycle, state.claims),
            {
              cycle: cycle.map((edge) => ({
                from: edge.from,
                to: edge.to,
                path: edge.path.display,
              })),
              youHold: claimsHeldBy(state, {
                kind: "session",
                sessionId: input.sessionId,
              }).map((claim) => claim.path.display),
            },
          );
        }

        const next = withWait(state, wait);
        const effects: ClaimEffect[] = [{ kind: "wait-added", wait }];
        if (wait.authorizedAt === null) {
          effects.push({
            kind: "approval-required",
            wait,
            grantorClaimId: evaluation.authority.id,
            grantor: evaluation.authority.holder,
          });
        }
        return {
          ok: true,
          state: next,
          effects,
          result: waitResult(next, wait),
        };
      }
    }
  }

  /**
   * What to tell the requester. An unanswered approval is the more actionable
   * report of the two gates — it names someone who can clear it — so it wins
   * when both are open.
   */
  function waitResult(state: ClaimState, wait: ClaimWait): ClaimRequestResult {
    if (wait.authorizedAt === null && wait.grantorClaimId !== null) {
      const grantor = claimById(state, wait.grantorClaimId);
      if (grantor) {
        return {
          kind: "approval-required",
          wait,
          grantor: grantor.holder,
          grantorClaimId: grantor.id,
          position: positionOf(state, wait),
          blockedBy: blockersOf(state, wait),
        };
      }
    }
    return {
      kind: "waiting",
      wait,
      position: positionOf(state, wait),
      blockedBy: blockersOf(state, wait),
    };
  }

  function renewClaim(
    state: ClaimState,
    claim: Claim,
    at: number,
  ): { state: ClaimState; effects: readonly ClaimEffect[]; claim: Claim } {
    if (claim.lastActivityAt >= at) return { state, effects: [], claim };
    const renewed: Claim = { ...claim, lastActivityAt: at };
    return {
      state: {
        ...state,
        claims: state.claims.map((existing) =>
          existing.id === claim.id ? renewed : existing,
        ),
      },
      effects: [
        { kind: "claim-renewed", claimId: claim.id, lastActivityAt: at },
      ],
      claim: renewed,
    };
  }

  function answerApproval(
    state: ClaimState,
    answer: ClaimApprovalAnswer,
  ): ClaimOutcome<
    ClaimRequestResult | { kind: "denied"; waitId: ClaimWaitId }
  > {
    const at = now(answer.at);
    const wait = state.waits.find(
      (candidate) => candidate.id === answer.waitId,
    );
    if (wait === undefined) {
      return refuse("no_such_wait", `unknown claim wait ${answer.waitId}`);
    }
    if (wait.authorizedAt !== null || wait.grantorClaimId === null) {
      return refuse(
        "not_holder",
        "this wait is already authorized and only waiting for the path to free; nothing to answer",
      );
    }
    const grantor = claimById(state, wait.grantorClaimId);
    if (grantor === undefined) {
      return refuse(
        "no_such_claim",
        "the granting claim is gone; the wait will re-raise",
      );
    }
    if (!authorizedToRelease(grantor, answer.by)) {
      return refuse(
        "not_holder",
        `only ${describeAuthor(grantor.holder)} (who holds ${describePath(grantor.path)}) or the operator may answer this`,
      );
    }

    if (answer.decision === "deny") {
      return {
        ok: true,
        state: withoutWait(state, wait.id),
        effects: [{ kind: "wait-removed", waitId: wait.id, reason: "refused" }],
        result: { kind: "denied", waitId: wait.id },
      };
    }

    // Re-evaluate rather than trusting the wait: the path may have been taken
    // while the approval sat unanswered.
    const evaluation = evaluate(state, wait.sessionId, wait.path);
    if (evaluation.kind === "already-held") {
      return {
        ok: true,
        state: withoutWait(state, wait.id),
        effects: [{ kind: "wait-removed", waitId: wait.id, reason: "granted" }],
        result: { kind: "already-held", claim: evaluation.claim },
      };
    }
    if (evaluation.kind === "denied") {
      return refuse(
        "policy_denied",
        `${describePath(wait.path)} is closed by a standing policy (${describePolicy(evaluation.by)})`,
      );
    }
    if (evaluation.kind === "no-root") {
      return refuse("no_such_claim", "this workstream has no root claim");
    }

    // The answer settles authorization. Availability is the other gate: if the
    // path was taken while the approval sat unanswered, the session keeps its
    // place in the waitlist — now authorized, so freeing the path grants it.
    const authorized: ClaimWait = {
      ...wait,
      authorizedAt: at,
      grantorClaimId: evaluation.authority.id,
      blockedByClaimIds: evaluation.blockers.map((claim) => claim.id),
    };
    if (evaluation.blockers.length > 0) {
      const next = withWait(withoutWait(state, wait.id), authorized);
      // Answering rewrites the blocker set, which can close a cycle as surely as
      // a promotion can: an approval edge becomes a held-path edge, and the loop
      // that was waiting on a human answer is now waiting on a session.
      const swept = breakDeadlocks(next);
      const survived = swept.state.waits.find(
        (candidate) => candidate.id === authorized.id,
      );
      const effects: readonly ClaimEffect[] = [
        { kind: "wait-updated", wait: authorized },
        ...swept.effects,
      ];
      if (survived === undefined) {
        // The answer was honoured and then the wait had to go; the refusal effect
        // carries the reason, and the caller sees it as a refusal too.
        const refusal = swept.effects.find(
          (effect) => effect.kind === "deadlock-refused",
        );
        return refuse(
          "would_deadlock",
          refusal && refusal.kind === "deadlock-refused"
            ? refusal.message
            : "granting this would deadlock",
        );
      }
      return {
        ok: true,
        state: swept.state,
        effects,
        result: waitResult(swept.state, survived),
      };
    }

    const claim = makeClaim(state, {
      path: wait.path,
      holder: { kind: "session", sessionId: wait.sessionId },
      grantedFromClaimId: evaluation.authority.id,
      grantedBy: answer.by,
      at,
      leaseSeconds: waitLeaseSeconds(wait),
    });
    return {
      ok: true,
      state: withoutWait(withClaim(state, claim), wait.id),
      effects: [
        { kind: "claim-granted", claim },
        { kind: "wait-removed", waitId: wait.id, reason: "granted" },
      ],
      result: { kind: "granted", claim },
    };
  }

  /**
   * The operator's grant (§3.4: "the human may grant, revoke, or force-release
   * anything"). It ignores policy — a deny is a holder's rule, and the operator
   * outranks it — but it never stomps a live holder: taking a path from a wedged
   * session is force-release, deliberately a separate verb.
   *
   * Availability is therefore checked **before policy is consulted at all**. The
   * order matters: a deny policy over a held path used to short-circuit the
   * blocker check, and the grant landed on top of the live holder — two live
   * claims, the first holder silently losing authority, and no release effect for
   * anyone to see.
   */
  function grant(
    state: ClaimState,
    input: ClaimGrantRequest,
  ): ClaimOutcome<ClaimRequestResult> {
    if (input.by.kind !== "human") {
      return refuse(
        "human_only",
        "only the operator grants a claim directly; a session's own grants follow the path hierarchy",
      );
    }
    const at = now(input.at);
    const swept = sweepExpired(state, at);
    return withPriorEffects(
      swept.effects,
      grantAgainst(swept.state, { ...input, at }),
    );
  }

  function grantAgainst(
    state: ClaimState,
    input: ClaimGrantRequest,
  ): ClaimOutcome<ClaimRequestResult> {
    if (input.by.kind !== "human") {
      return refuse(
        "human_only",
        "only the operator grants a claim directly; a session's own grants follow the path hierarchy",
      );
    }
    const at = now(input.at);
    const path = resolve(input.path);
    if (isRefusal(path)) return { ok: false, refusal: path };

    const evaluation = evaluate(state, input.to, path);
    if (evaluation.kind === "no-root") {
      return refuse("no_such_claim", "this workstream has no root claim");
    }
    if (evaluation.kind === "already-held") {
      return {
        ok: true,
        state,
        effects: [],
        result: { kind: "already-held", claim: evaluation.claim },
      };
    }
    if (evaluation.blockers.length > 0) {
      const holders = evaluation.blockers
        .map(
          (claim) =>
            `${describePath(claim.path)} (${describeAuthor(claim.holder)})`,
        )
        .join(", ");
      return refuse(
        "already_held",
        `held by ${holders}; force-release it first rather than granting over it`,
        { blockedByClaimIds: evaluation.blockers.map((claim) => claim.id) },
      );
    }

    // Only now does policy come up, and only to be overridden: a deny is a
    // holder's rule and the operator outranks it (§3.4). The grant still hangs
    // from the deepest enclosing claim, so the tree and the extent invariant stay
    // intact, and `grantedBy: human` records the override.
    const authority = evaluation.authority;
    const claim = makeClaim(state, {
      path,
      holder: { kind: "session", sessionId: input.to },
      grantedFromClaimId: authority.id,
      grantedBy: input.by,
      at,
      leaseSeconds: input.leaseSeconds,
    });
    const promoted = promoteWaiters(withClaim(state, claim), at);
    return {
      ok: true,
      state: promoted.state,
      effects: [{ kind: "claim-granted", claim }, ...promoted.effects],
      result: { kind: "granted", claim },
    };
  }

  function yieldClaim(
    state: ClaimState,
    input: ClaimReleaseRequest,
  ): ClaimOutcome<{ released: ClaimId }> {
    const at = now(input.at);
    const claim = claimById(state, input.claimId);
    if (claim === undefined) {
      return refuse("no_such_claim", `unknown claim ${input.claimId}`);
    }
    if (claim.grantedFromClaimId === null) {
      return refuse(
        "root_claim_immutable",
        "the root claim is the operator's own authority; it cannot be yielded",
      );
    }
    if (!authorizedToRelease(claim, input.by)) {
      return refuse(
        "not_holder",
        `${describePath(claim.path)} is held by ${describeAuthor(claim.holder)}; only its holder or the operator releases it`,
      );
    }

    const released = releaseClaims(state, [claim.id], "yielded", at, false);
    const promoted = promoteWaiters(released.state, at);
    return {
      ok: true,
      state: promoted.state,
      effects: [...released.effects, ...promoted.effects],
      result: { released: claim.id },
    };
  }

  function forceRelease(
    state: ClaimState,
    input: ClaimForceReleaseRequest,
  ): ClaimOutcome<{ released: readonly ClaimId[] }> {
    if (input.by.kind !== "human") {
      return refuse(
        "human_only",
        "force-release is the operator's escape hatch for a wedged holder whose grantor is wedged too",
      );
    }
    const at = now(input.at);
    const claim = claimById(state, input.claimId);
    if (claim === undefined) {
      return refuse("no_such_claim", `unknown claim ${input.claimId}`);
    }
    if (claim.grantedFromClaimId === null) {
      return refuse(
        "root_claim_immutable",
        "the root claim is the operator's own authority; it cannot be released",
      );
    }

    const cascade = input.cascade ?? false;
    const released = releaseClaims(
      state,
      [claim.id],
      cascade ? "revoked" : "force-released",
      at,
      cascade,
    );
    const promoted = promoteWaiters(released.state, at);
    return {
      ok: true,
      state: promoted.state,
      effects: [...released.effects, ...promoted.effects],
      result: { released: released.released },
    };
  }

  function withdrawWait(
    state: ClaimState,
    input: { waitId: ClaimWaitId; by: Author },
  ): ClaimOutcome<{ withdrawn: ClaimWaitId }> {
    const wait = state.waits.find((candidate) => candidate.id === input.waitId);
    if (wait === undefined) {
      return refuse("no_such_wait", `unknown claim wait ${input.waitId}`);
    }
    if (
      input.by.kind !== "human" &&
      !(input.by.kind === "session" && input.by.sessionId === wait.sessionId)
    ) {
      return refuse(
        "not_holder",
        "a waitlist place belongs to the session waiting; only it or the operator withdraws it",
      );
    }
    return {
      ok: true,
      state: withoutWait(state, wait.id),
      effects: [{ kind: "wait-removed", waitId: wait.id, reason: "withdrawn" }],
      result: { withdrawn: wait.id },
    };
  }

  function declarePolicy(
    state: ClaimState,
    input: ClaimPolicyDeclaration,
  ): ClaimOutcome<{ policy: ClaimPolicy }> {
    const at = now(input.at);
    const claim = claimById(state, input.claimId);
    if (claim === undefined) {
      return refuse("no_such_claim", `unknown claim ${input.claimId}`);
    }
    if (!authorizedToRelease(claim, input.by)) {
      return refuse(
        "not_holder",
        `only ${describeAuthor(claim.holder)} or the operator declares policy on ${describePath(claim.path)}`,
      );
    }
    const subtree = resolve(input.subtree);
    if (isRefusal(subtree)) return { ok: false, refusal: subtree };

    // The capability invariant applies to pre-granting too: a holder cannot
    // pre-grant reach it does not hold (§3.4, principle 1).
    const extent = checkGrantExtent(claim, subtree);
    if (!extent.allowed) return { ok: false, refusal: extent.refusal };

    const policy: ClaimPolicy = {
      id: ids.policy(),
      declaredByClaimId: claim.id,
      subtree,
      effect: input.effect,
      pattern: input.pattern ?? MATCH_EVERYTHING,
      declaredAt: at,
    };
    const promoted = promoteWaiters(
      { ...state, policies: [...state.policies, policy] },
      at,
    );
    return {
      ok: true,
      state: promoted.state,
      effects: [{ kind: "policy-declared", policy }, ...promoted.effects],
      result: { policy },
    };
  }

  function withdrawPolicy(
    state: ClaimState,
    input: { policyId: ClaimPolicyId; by: Author },
  ): ClaimOutcome<{ withdrawn: ClaimPolicyId }> {
    const policy = state.policies.find(
      (candidate) => candidate.id === input.policyId,
    );
    if (policy === undefined) {
      return refuse("no_such_claim", `unknown claim policy ${input.policyId}`);
    }
    const claim = claimById(state, policy.declaredByClaimId);
    if (claim !== undefined && !authorizedToRelease(claim, input.by)) {
      return refuse(
        "not_holder",
        `only ${describeAuthor(claim.holder)} or the operator withdraws that policy`,
      );
    }
    return {
      ok: true,
      state: {
        ...state,
        policies: state.policies.filter(
          (candidate) => candidate.id !== policy.id,
        ),
      },
      effects: [
        { kind: "policy-withdrawn", policyId: policy.id, reason: "withdrawn" },
      ],
      result: { withdrawn: policy.id },
    };
  }

  function renew(
    state: ClaimState,
    input: ClaimReleaseRequest,
  ): ClaimOutcome<{ claim: Claim }> {
    const at = now(input.at);
    const claim = claimById(state, input.claimId);
    if (claim === undefined) {
      return refuse("no_such_claim", `unknown claim ${input.claimId}`);
    }
    if (!authorizedToRelease(claim, input.by)) {
      return refuse(
        "not_holder",
        `${describePath(claim.path)} is held by ${describeAuthor(claim.holder)}`,
      );
    }
    const renewed = renewClaim(state, claim, at);
    return {
      ok: true,
      state: renewed.state,
      effects: renewed.effects,
      result: { claim: renewed.claim },
    };
  }

  /**
   * Activity renews the lease that covers the path it happened in — not every
   * claim the session holds. A session working in `src/api/` while sitting on
   * `docs/` should lose `docs/`; that is what leases are for.
   */
  function recordActivity(
    state: ClaimState,
    input: ClaimActivity,
  ): ClaimOutcome<{ renewed: readonly ClaimId[] }> {
    const at = now(input.at);
    const path = resolve(input.path);
    if (isRefusal(path)) return { ok: false, refusal: path };

    const holder: Author = { kind: "session", sessionId: input.sessionId };
    const covering = state.claims.filter(
      (claim) => isHeldBy(claim, holder) && isWithin(path, claim.path),
    );
    let current = state;
    const effects: ClaimEffect[] = [];
    for (const claim of covering) {
      const renewed = renewClaim(current, claim, at);
      current = renewed.state;
      effects.push(...renewed.effects);
    }
    return {
      ok: true,
      state: current,
      effects,
      result: { renewed: covering.map((claim) => claim.id) },
    };
  }

  /**
   * May this actor write this path, right now?
   *
   * **Lapse-aware**, deliberately: a claim whose lease ran out authorizes nothing
   * even when no sweep has run yet. A lease that only takes effect once a
   * background job gets around to it is not a lease, and the window would be
   * exactly when two sessions both believe they hold a path.
   */
  function checkWrite(
    state: ClaimState,
    actor: Author,
    rawPath: string | ClaimPath,
    asOf?: number,
  ): ClaimWriteCheck {
    const at = now(asOf);
    const path = resolve(rawPath);
    if (isRefusal(path)) return { allowed: false, refusal: path };

    const authority = authorityFor(state, path, { asOf: at });
    // The operator is an implicit claim holder of everything (§3.4): a human
    // editing files alongside sessions is the normal case, not an anomaly.
    if (actor.kind === "human")
      return { allowed: true, claim: authority ?? null };

    if (authority === undefined) {
      return {
        allowed: false,
        refusal: {
          reason: "no_such_claim",
          message:
            "this workstream has no root claim; nothing may be written yet",
        },
      };
    }
    if (isHeldBy(authority, actor)) return { allowed: true, claim: authority };

    // A lapsed claim of the caller's own is the confusing case, so it gets its
    // own message: the session thinks it holds this path, and the reason it does
    // not is a lease it let run out.
    const lapsed = state.claims.find(
      (claim) =>
        isHeldBy(claim, actor) &&
        isWithin(path, claim.path) &&
        isExpired(claim, at),
    );
    if (lapsed) {
      return {
        allowed: false,
        refusal: {
          reason: "not_holder",
          message: `your claim on ${describePath(lapsed.path)} lapsed after ${lapsed.leaseSeconds ?? 0}s without activity; request it again`,
          details: {
            path: path.display,
            lapsedClaimId: lapsed.id,
            lapsedAt: leaseExpiresAt(lapsed),
          },
        },
      };
    }

    return {
      allowed: false,
      refusal: {
        reason: "not_holder",
        message: `${describePath(path)} is held by ${describeAuthor(authority.holder)}; request a claim on it (you will be waitlisted) or write inside a path you hold`,
        details: {
          path: path.display,
          holderClaimId: authority.id,
          holderPath: authority.path.display,
          holder: authority.holder,
        },
      },
    };
  }

  function recordWrite(
    state: ClaimState,
    input: ClaimWriteRecord,
  ): ClaimOutcome<{ write: PathWrite }> {
    const at = now(input.at);
    const path = resolve(input.path);
    if (isRefusal(path)) return { ok: false, refusal: path };

    const check = checkWrite(state, input.actor, path);
    if (!check.allowed) return { ok: false, refusal: check.refusal };

    const write: PathWrite = {
      path,
      holder: input.actor,
      claimId: input.actor.kind === "human" ? null : (check.claim?.id ?? null),
      at,
    };

    if (input.actor.kind === "session" && check.claim) {
      const renewed = renewClaim(state, check.claim, at);
      return {
        ok: true,
        state: renewed.state,
        effects: renewed.effects,
        result: { write },
      };
    }
    return { ok: true, state, effects: [], result: { write } };
  }

  function expire(
    state: ClaimState,
    at?: number,
  ): ClaimOutcome<{ expired: readonly ClaimId[] }> {
    const stamp = now(at);
    const lapsed = state.claims.filter(
      (claim) => claim.grantedFromClaimId !== null && isExpired(claim, stamp),
    );
    if (lapsed.length === 0) {
      return { ok: true, state, effects: [], result: { expired: [] } };
    }
    const released = releaseClaims(
      state,
      lapsed.map((claim) => claim.id),
      "expired",
      stamp,
      false,
    );
    const promoted = promoteWaiters(released.state, stamp);
    return {
      ok: true,
      state: promoted.state,
      effects: [...released.effects, ...promoted.effects],
      result: { expired: released.released },
    };
  }

  /**
   * "A session ending releases everything it held automatically (explicit yield
   * is an optimization)" — including its place in every waitlist, and the
   * policies its claims declared.
   */
  function endSession(
    state: ClaimState,
    sessionId: SessionId,
    at?: number,
  ): ClaimOutcome<{
    released: readonly ClaimId[];
    waitsRemoved: readonly ClaimWaitId[];
  }> {
    const stamp = now(at);
    const held = claimsHeldBy(state, { kind: "session", sessionId });
    const waits = state.waits.filter((wait) => wait.sessionId === sessionId);

    const released = releaseClaims(
      state,
      held.map((claim) => claim.id),
      "session-ended",
      stamp,
      false,
    );
    let current: ClaimState = {
      ...released.state,
      waits: released.state.waits.filter(
        (wait) => wait.sessionId !== sessionId,
      ),
    };
    const effects: ClaimEffect[] = [
      ...released.effects,
      ...waits.map((wait): ClaimEffect => ({
        kind: "wait-removed",
        waitId: wait.id,
        reason: "session-ended",
      })),
    ];
    const promoted = promoteWaiters(current, stamp);
    current = promoted.state;
    effects.push(...promoted.effects);

    return {
      ok: true,
      state: current,
      effects,
      result: {
        released: released.released,
        waitsRemoved: waits.map((wait) => wait.id),
      },
    };
  }

  function inspect(
    state: ClaimState,
    view: { sessionId?: SessionId; at?: number } = {},
  ): ClaimInspection {
    const at = now(view.at);
    const holder: Author | null =
      view.sessionId === undefined
        ? null
        : { kind: "session", sessionId: view.sessionId };

    const held = state.claims
      .filter((claim) => (holder === null ? true : isHeldBy(claim, holder)))
      .map((claim) => ({
        claim,
        heldForSeconds: Math.max(0, at - claim.grantedAt),
        expiresAt: leaseExpiresAt(claim),
        subGrants: subClaimsOf(state, claim.id),
      }));

    const waiting = state.waits
      .filter((wait) =>
        holder === null ? true : wait.sessionId === view.sessionId,
      )
      .map((wait) => {
        const grantor =
          wait.grantorClaimId === null
            ? null
            : claimById(state, wait.grantorClaimId);
        const waitingForSeconds = Math.max(0, at - wait.since);
        return {
          wait,
          position: positionOf(state, wait),
          reason: claimWaitReason(wait),
          waitingForSeconds,
          blockedBy: blockersOf(state, wait),
          grantor: grantor?.holder ?? null,
          pastAlertThreshold:
            waitingForSeconds >= CLAIM_WAIT_ALERT_THRESHOLD_SECONDS,
        };
      })
      .sort((a, b) => a.position - b.position);

    const othersHold =
      holder === null
        ? []
        : state.claims.filter((claim) => !isHeldBy(claim, holder));

    // Every live policy, not a per-path subset: applicability is per requested
    // path (`evaluatePolicies` answers that), and a session inspecting claims
    // needs to see the rules it will be judged by before it picks a path.
    const policies = state.policies;

    return {
      workstreamId: state.workstreamId,
      observedAt: at,
      held,
      waiting,
      othersHold,
      policiesInForce: policies,
    };
  }

  function waitMetrics(
    state: ClaimState,
    options: { at?: number; thresholdSeconds?: number } = {},
  ): ClaimWaitMetrics {
    const at = now(options.at);
    const threshold =
      options.thresholdSeconds ?? CLAIM_WAIT_ALERT_THRESHOLD_SECONDS;

    const waits = state.waits.map((wait) => {
      const grantor =
        wait.grantorClaimId === null
          ? undefined
          : claimById(state, wait.grantorClaimId);
      const waitingForSeconds = Math.max(0, at - wait.since);
      return {
        waitId: wait.id,
        sessionId: wait.sessionId,
        path: wait.path,
        reason: claimWaitReason(wait),
        waitingForSeconds,
        pastAlertThreshold: waitingForSeconds >= threshold,
        blockedOnHuman:
          claimWaitReason(wait) === "approval" &&
          grantor?.holder.kind === "human",
      };
    });

    const overlapping: OverlappingWait[] = [];
    for (const wait of state.waits) {
      const others = state.waits.filter(
        (other) => other.id !== wait.id && pathsConflict(other.path, wait.path),
      );
      if (others.length === 0) continue;
      if (overlapping.some((group) => group.path.key === wait.path.key))
        continue;
      overlapping.push({
        path: wait.path,
        sessionIds: [wait.sessionId, ...others.map((other) => other.sessionId)],
      });
    }

    return {
      observedAt: at,
      waits,
      blockedOnHumanSeconds: waits
        .filter((wait) => wait.blockedOnHuman)
        .reduce((total, wait) => total + wait.waitingForSeconds, 0),
      blockedOnSessionSeconds: waits
        .filter((wait) => !wait.blockedOnHuman)
        .reduce((total, wait) => total + wait.waitingForSeconds, 0),
      overlapping,
    };
  }

  function isWaitingOnClaim(state: ClaimState, sessionId: SessionId): boolean {
    return state.waits.some((wait) => wait.sessionId === sessionId);
  }

  return {
    open,
    request,
    answerApproval,
    grant,
    yieldClaim,
    forceRelease,
    withdrawWait,
    declarePolicy,
    withdrawPolicy,
    renew,
    recordActivity,
    recordWrite,
    checkWrite,
    expire,
    endSession,
    inspect,
    waitMetrics,
    isWaitingOnClaim,
  };
}

export function describeAuthor(author: Author): string {
  return author.kind === "human"
    ? "the operator"
    : `session ${author.sessionId}`;
}
