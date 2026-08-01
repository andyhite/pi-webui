import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  claimPath,
  systemClock,
  type Author,
  type Claim,
  type ClaimEffect,
  type ClaimId,
  type ClaimPolicy,
  type ClaimPolicyId,
  type ClaimState,
  type ClaimWait,
  type ClaimWaitId,
  type Clock,
  type PathRead,
  type PathWrite,
  type SessionId,
  type WorkstreamId,
} from "@plotroom/core";
import type { PlotroomDatabase } from "./client.js";
import {
  claimPolicies,
  claims,
  claimWaits,
  pathReads,
  pathWrites,
  type ClaimPolicyRow,
  type ClaimRow,
  type ClaimWaitRow,
} from "./schema.js";

/**
 * Path claims at rest (§3.4, Epic 4.4's deferred persistence).
 *
 * `@plotroom/core`'s `claims/` subtree stated the contract exactly: "`ClaimState`
 * plus the `ClaimEffect` list is the persistence contract Track A implements".
 * This store is that and nothing else — it reads a workstream's state, hands it
 * to the manager, and applies whatever effects come back. **No rule is decided
 * here.** A store that re-derived "is this path held" would be the second
 * implementation principle 8 exists to prevent.
 *
 * Rows are retired rather than deleted, because a release and an expiry are
 * different events even when the row change is identical: `release_reason` is
 * the record of which, and it is what a claims audit reads.
 */
export class ClaimStore {
  constructor(
    private readonly state: PlotroomDatabase,
    private readonly now: Clock = systemClock,
  ) {}

  /* ---------------------------------------------------------------- reading */

  /** Everything the manager decides from, for one workstream. */
  claimState(workstreamId: string): ClaimState {
    return {
      workstreamId: workstreamId as WorkstreamId,
      claims: this.liveClaims(workstreamId),
      waits: this.liveWaits(workstreamId),
      policies: this.livePolicies(workstreamId),
    };
  }

  /**
   * The workstream a claim, wait, or policy belongs to.
   *
   * The manager's verbs are addressed by id (`yieldClaim`, `answerApproval`,
   * `withdrawPolicy`) but decide over one workstream's whole state, so this is
   * the lookup that turns an id into the state to decide from. Undefined means
   * the id names nothing live — which the manager itself reports as
   * `no_such_claim` rather than this store guessing at a refusal.
   */
  workstreamOfClaim(claimId: string): string | undefined {
    return this.state.db
      .select({ workstreamId: claims.workstreamId })
      .from(claims)
      .where(eq(claims.id, claimId))
      .get()?.workstreamId;
  }

  workstreamOfWait(waitId: string): string | undefined {
    return this.state.db
      .select({ workstreamId: claimWaits.workstreamId })
      .from(claimWaits)
      .where(eq(claimWaits.id, waitId))
      .get()?.workstreamId;
  }

  workstreamOfPolicy(policyId: string): string | undefined {
    return this.state.db
      .select({ workstreamId: claims.workstreamId })
      .from(claimPolicies)
      .innerJoin(claims, eq(claims.id, claimPolicies.claimId))
      .where(eq(claimPolicies.id, policyId))
      .get()?.workstreamId;
  }

  /**
   * The workstream a session is waiting for a claim in, if it is waiting at all.
   * `waiting on a claim` is a session phase (§3.6), so the phase derivation needs
   * this without knowing which workstream to look in.
   */
  workstreamOfWaitingSession(sessionId: string): string | undefined {
    return this.state.db
      .select({ workstreamId: claimWaits.workstreamId })
      .from(claimWaits)
      .where(
        and(eq(claimWaits.sessionId, sessionId), isNull(claimWaits.removedAt)),
      )
      .get()?.workstreamId;
  }

  /** Which workstreams have any claim state at all — the sweep's own list. */
  workstreamsWithClaims(): readonly string[] {
    const rows = this.state.db
      .selectDistinct({ workstreamId: claims.workstreamId })
      .from(claims)
      .where(isNull(claims.releasedAt))
      .all();
    return rows.map((row) => row.workstreamId);
  }

  /* --------------------------------------------------------------- applying */

  /**
   * Apply what the manager decided, in order, inside one transaction.
   *
   * Order matters and is the manager's: a reattachment that landed before the
   * release it follows would momentarily describe a claim hanging from a
   * released grantor, and a reader mid-transaction is exactly what a WAL
   * database permits.
   */
  apply(workstreamId: string, effects: readonly ClaimEffect[]): void {
    if (effects.length === 0) return;

    this.state.db.transaction(() => {
      for (const effect of effects) this.applyOne(workstreamId, effect);
    });
  }

  private applyOne(workstreamId: string, effect: ClaimEffect): void {
    const db = this.state.db;

    switch (effect.kind) {
      case "claim-granted":
        db.insert(claims)
          .values({
            id: effect.claim.id,
            workstreamId,
            pathKey: effect.claim.path.key,
            pathDisplay: effect.claim.path.display,
            holderKind: effect.claim.holder.kind,
            holderSession:
              effect.claim.holder.kind === "session"
                ? effect.claim.holder.sessionId
                : null,
            grantedFromClaimId: effect.claim.grantedFromClaimId,
            grantedByKind: effect.claim.grantedBy.kind,
            grantedBySession:
              effect.claim.grantedBy.kind === "session"
                ? effect.claim.grantedBy.sessionId
                : null,
            grantedAt: effect.claim.grantedAt,
            lastActivityAt: effect.claim.lastActivityAt,
            leaseSeconds: effect.claim.leaseSeconds,
            releasedAt: null,
            releaseReason: null,
          })
          .run();
        return;

      case "claim-released":
        db.update(claims)
          .set({ releasedAt: effect.at, releaseReason: effect.reason })
          .where(eq(claims.id, effect.claimId))
          .run();
        return;

      case "claim-reattached":
        db.update(claims)
          .set({ grantedFromClaimId: effect.grantedFromClaimId })
          .where(eq(claims.id, effect.claimId))
          .run();
        return;

      case "claim-renewed":
        db.update(claims)
          .set({ lastActivityAt: effect.lastActivityAt })
          .where(eq(claims.id, effect.claimId))
          .run();
        return;

      case "wait-added":
        db.insert(claimWaits)
          .values({
            id: effect.wait.id,
            workstreamId,
            sessionId: effect.wait.sessionId,
            pathKey: effect.wait.path.key,
            pathDisplay: effect.wait.path.display,
            since: effect.wait.since,
            blockedByJson: JSON.stringify(effect.wait.blockedByClaimIds),
            grantorClaimId: effect.wait.grantorClaimId,
            authorizedAt: effect.wait.authorizedAt,
            requestedLeaseSeconds: effect.wait.requestedLeaseSeconds,
            removedAt: null,
            removedReason: null,
          })
          .run();
        return;

      case "wait-updated":
        db.update(claimWaits)
          .set({
            blockedByJson: JSON.stringify(effect.wait.blockedByClaimIds),
            grantorClaimId: effect.wait.grantorClaimId,
            authorizedAt: effect.wait.authorizedAt,
            requestedLeaseSeconds: effect.wait.requestedLeaseSeconds,
          })
          .where(eq(claimWaits.id, effect.wait.id))
          .run();
        return;

      case "wait-removed":
        db.update(claimWaits)
          .set({ removedAt: this.now(), removedReason: effect.reason })
          .where(eq(claimWaits.id, effect.waitId))
          .run();
        return;

      case "policy-declared":
        db.insert(claimPolicies)
          .values({
            id: effect.policy.id,
            claimId: effect.policy.declaredByClaimId,
            subtreeKey: effect.policy.subtree.key,
            subtreeDisplay: effect.policy.subtree.display,
            effect: effect.policy.effect,
            pattern: effect.policy.pattern,
            declaredAt: effect.policy.declaredAt,
            withdrawnAt: null,
            withdrawReason: null,
          })
          .run();
        return;

      case "policy-withdrawn":
        db.update(claimPolicies)
          .set({ withdrawnAt: this.now(), withdrawReason: effect.reason })
          .where(eq(claimPolicies.id, effect.policyId))
          .run();
        return;

      // Neither of these is a row change: a refused deadlock and a raised
      // approval are announcements, and the `wait-removed` / `wait-added` beside
      // them is what storage records. Publishing them is the caller's business.
      case "deadlock-refused":
      case "approval-required":
        return;
    }
  }

  /* ----------------------------------------------------------- write ledger */

  /**
   * One observed write (§3.4). The claim manager decided who held the path;
   * this only records what it said, which is what makes claim-precise divergence
   * a query rather than a guess.
   */
  recordWrite(workstreamId: string, write: PathWrite): PathWrite {
    this.state.db
      .insert(pathWrites)
      .values({
        id: `pwrite_${randomUUID()}`,
        workstreamId,
        pathKey: write.path.key,
        pathDisplay: write.path.display,
        holderKind: write.holder.kind,
        holderSession:
          write.holder.kind === "session" ? write.holder.sessionId : null,
        claimId: write.claimId,
        at: write.at,
      })
      .run();
    return write;
  }

  /** One observed read, so staleness can compare against when a session looked. */
  recordRead(
    workstreamId: string,
    sessionId: string,
    read: PathRead,
  ): PathRead {
    this.state.db
      .insert(pathReads)
      .values({
        id: `pread_${randomUUID()}`,
        workstreamId,
        sessionId,
        pathKey: read.path.key,
        pathDisplay: read.path.display,
        at: read.at,
      })
      .run();
    return read;
  }

  writes(workstreamId: string): readonly PathWrite[] {
    return this.state.db
      .select()
      .from(pathWrites)
      .where(eq(pathWrites.workstreamId, workstreamId))
      .all()
      .map((row) => ({
        path: claimPath(row.pathDisplay),
        holder:
          row.holderKind === "session"
            ? {
                kind: "session" as const,
                sessionId: row.holderSession as SessionId,
              }
            : { kind: "human" as const },
        claimId: row.claimId === null ? null : (row.claimId as ClaimId),
        at: row.at,
      }));
  }

  reads(sessionId: string): readonly PathRead[] {
    return this.state.db
      .select()
      .from(pathReads)
      .where(eq(pathReads.sessionId, sessionId))
      .all()
      .map((row) => ({ path: claimPath(row.pathDisplay), at: row.at }));
  }

  /* ----------------------------------------------------------------- private */

  private liveClaims(workstreamId: string): readonly Claim[] {
    return this.state.db
      .select()
      .from(claims)
      .where(
        and(eq(claims.workstreamId, workstreamId), isNull(claims.releasedAt)),
      )
      .all()
      .map((row) => toClaim(row));
  }

  private liveWaits(workstreamId: string): readonly ClaimWait[] {
    return this.state.db
      .select()
      .from(claimWaits)
      .where(
        and(
          eq(claimWaits.workstreamId, workstreamId),
          isNull(claimWaits.removedAt),
        ),
      )
      .all()
      .map((row) => toWait(row));
  }

  /**
   * Policies live inside the claim that declared them, so a workstream's
   * policies are the live policies of its live claims — a policy whose claim was
   * released is not consulted even before the `policy-withdrawn` effect lands.
   */
  private livePolicies(workstreamId: string): readonly ClaimPolicy[] {
    const rows = this.state.db
      .select({ policy: claimPolicies })
      .from(claimPolicies)
      .innerJoin(claims, eq(claims.id, claimPolicies.claimId))
      .where(
        and(
          eq(claims.workstreamId, workstreamId),
          isNull(claims.releasedAt),
          isNull(claimPolicies.withdrawnAt),
        ),
      )
      .all();

    return rows.map((row) => toPolicy(row.policy));
  }
}

function authorOf(kind: string, sessionId: string | null): Author {
  return kind === "session"
    ? { kind: "session", sessionId: sessionId as SessionId }
    : { kind: "human" };
}

function toClaim(row: ClaimRow): Claim {
  return {
    id: row.id as ClaimId,
    workstreamId: row.workstreamId as WorkstreamId,
    // Re-canonicalized from the display form rather than stored as segments: the
    // canonicalization is the rule, and reading it back through the same
    // function is what keeps a stored row and a fresh request identical.
    path: claimPath(row.pathDisplay),
    holder: authorOf(row.holderKind, row.holderSession),
    grantedFromClaimId:
      row.grantedFromClaimId === null
        ? null
        : (row.grantedFromClaimId as ClaimId),
    grantedBy: authorOf(row.grantedByKind, row.grantedBySession),
    grantedAt: row.grantedAt,
    lastActivityAt: row.lastActivityAt,
    leaseSeconds: row.leaseSeconds,
  };
}

function toWait(row: ClaimWaitRow): ClaimWait {
  return {
    id: row.id as ClaimWaitId,
    workstreamId: row.workstreamId as WorkstreamId,
    sessionId: row.sessionId as SessionId,
    path: claimPath(row.pathDisplay),
    since: row.since,
    blockedByClaimIds: JSON.parse(row.blockedByJson) as ClaimId[],
    grantorClaimId:
      row.grantorClaimId === null ? null : (row.grantorClaimId as ClaimId),
    authorizedAt: row.authorizedAt,
    requestedLeaseSeconds: row.requestedLeaseSeconds,
  };
}

function toPolicy(row: ClaimPolicyRow): ClaimPolicy {
  return {
    id: row.id as ClaimPolicyId,
    declaredByClaimId: row.claimId as ClaimId,
    subtree: claimPath(row.subtreeDisplay),
    effect: row.effect,
    pattern: row.pattern,
    declaredAt: row.declaredAt,
  };
}
