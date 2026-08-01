import { describe, expect, it } from "vitest";

import { humanAuthor, sessionAuthor } from "../author.js";
import {
  createClaimManager,
  DEFAULT_CLAIM_LEASE_SECONDS,
  type ClaimManager,
} from "./manager.js";
import {
  claimsHeldBy,
  isHeldBy,
  rootClaimOf,
  violatesGrantExtent,
  violatesLeasePolicy,
  violatesSingleWriter,
  type Claim,
  type ClaimEffect,
  type ClaimOutcome,
  type ClaimState,
} from "./model.js";
import { countingClaimIds, session, testClock, ws } from "./testing.js";

const A = session("sess_a");
const B = session("sess_b");
const C = session("sess_c");

function setup(leaseSeconds = 900) {
  const clock = testClock();
  const manager = createClaimManager({
    clock,
    ids: countingClaimIds(),
    defaultLeaseSeconds: leaseSeconds,
  });
  const opened = manager.open(ws());
  return { clock, manager, state: opened.state, root: opened.rootClaim };
}

/** Unwrap an outcome, failing the test with the refusal rather than a type error. */
function ok<T>(outcome: ClaimOutcome<T>): {
  state: ClaimState;
  result: T;
  effects: readonly ClaimEffect[];
} {
  if (!outcome.ok) {
    throw new Error(
      `expected success, got refusal: ${outcome.refusal.reason} — ${outcome.refusal.message}`,
    );
  }
  return {
    state: outcome.state,
    result: outcome.result,
    effects: outcome.effects,
  };
}

function refusal<T>(outcome: ClaimOutcome<T>) {
  if (outcome.ok) throw new Error("expected a refusal, got success");
  return outcome.refusal;
}

/**
 * The operator pre-granting the whole workspace: "children may claim freely",
 * declared on the root claim (§3.4, plus §6.6's pre-granted approvals). It makes
 * the waitlist tests about *ordering* rather than about approvals.
 */
function openWithRootPolicy(
  manager: ClaimManager,
  state: ClaimState,
): ClaimState {
  const root = rootClaimOf(state) as Claim;
  const declared = manager.declarePolicy(state, {
    claimId: root.id,
    subtree: ".",
    effect: "allow",
    by: humanAuthor,
  });
  if (!declared.ok) throw new Error(declared.refusal.message);
  return declared.state;
}

/** The common opening move: one session takes a path with the operator's blessing. */
function granted(
  manager: ClaimManager,
  state: ClaimState,
  sessionId: typeof A,
  path: string,
): { state: ClaimState; claim: Claim } {
  const outcome = ok(
    manager.grant(state, { path, to: sessionId, by: humanAuthor }),
  );
  if (outcome.result.kind !== "granted") {
    throw new Error(`expected a grant, got ${outcome.result.kind}`);
  }
  return { state: outcome.state, claim: outcome.result.claim };
}

describe("the root claim", () => {
  it("is the operator's, covers everything, and never expires", () => {
    const { root, state, manager } = setup();
    expect(root.holder).toEqual(humanAuthor);
    expect(root.path.segments).toEqual([]);
    expect(root.leaseSeconds).toBeNull();
    expect(root.grantedFromClaimId).toBeNull();
    expect(rootClaimOf(state)?.id).toBe(root.id);

    // Even after a long silence: a lease on the human's own authority would
    // expire the ability to grant anything.
    const expired = ok(manager.expire(state, 1_700_000_000 + 10 ** 7));
    expect(expired.result.expired).toEqual([]);
  });

  it("cannot be yielded, force-released, or expired away", () => {
    const { manager, state, root } = setup();
    expect(
      refusal(manager.yieldClaim(state, { claimId: root.id, by: humanAuthor }))
        .reason,
    ).toBe("root_claim_immutable");
    expect(
      refusal(
        manager.forceRelease(state, { claimId: root.id, by: humanAuthor }),
      ).reason,
    ).toBe("root_claim_immutable");
  });
});

describe("the single-writer default (§3.4: no second concept)", () => {
  it("degenerates to one session holding the root path, writing everywhere", () => {
    const { manager, state, root } = setup();
    const first = granted(manager, state, A, ".");

    expect(first.claim.grantedFromClaimId).toBe(root.id);
    expect(first.claim.path.segments).toEqual([]);
    expect(
      manager.checkWrite(first.state, sessionAuthor(A), "src/auth.ts").allowed,
    ).toBe(true);
    expect(
      manager.checkWrite(
        first.state,
        sessionAuthor(A),
        "anything/not/created/yet.md",
      ).allowed,
    ).toBe(true);
    // One mechanism: the "default" is a grant from the root claim like any other.
    expect(first.state.claims).toHaveLength(2);
  });

  it("stops a session with no claim from writing, while leaving reads alone", () => {
    const { manager, state } = setup();
    const check = manager.checkWrite(state, sessionAuthor(A), "src/auth.ts");
    expect(check.allowed).toBe(false);
    if (check.allowed) return;
    expect(check.refusal.reason).toBe("not_holder");
    expect(check.refusal.message).toContain("the operator");
  });
});

describe("hierarchical conflict", () => {
  it("blocks a claim on a path someone else holds part of", () => {
    const { manager, state } = setup();
    const held = granted(
      manager,
      openWithRootPolicy(manager, state),
      A,
      "src/auth.ts",
    );

    const outcome = ok(
      manager.request(held.state, { sessionId: B, path: "src" }),
    );
    expect(outcome.result.kind).toBe("waiting");
    if (outcome.result.kind !== "waiting") return;
    expect(outcome.result.blockedBy.map((claim) => claim.id)).toEqual([
      held.claim.id,
    ]);
    expect(outcome.result.position).toBe(1);
  });

  it("treats a claim enclosing the path as the authority, not as a blocker", () => {
    const { manager, state } = setup();
    const held = granted(manager, state, A, "src");

    const outcome = ok(
      manager.request(held.state, { sessionId: B, path: "src/auth.ts" }),
    );
    expect(outcome.result.kind).toBe("approval-required");
    if (outcome.result.kind !== "approval-required") return;
    expect(outcome.result.grantor).toEqual(sessionAuthor(A));
  });

  it("covers paths that do not exist yet, and everything created under a directory", () => {
    const { manager, state } = setup();
    const held = granted(manager, state, A, "src/generated");

    expect(
      manager.checkWrite(
        held.state,
        sessionAuthor(A),
        "src/generated/new/file.ts",
      ).allowed,
    ).toBe(true);
    const blocked = manager.checkWrite(
      held.state,
      sessionAuthor(B),
      "src/generated/new/file.ts",
    );
    expect(blocked.allowed).toBe(false);
  });

  it("folds path spellings, so two holders never get one file", () => {
    const { manager, state } = setup();
    const held = granted(
      manager,
      openWithRootPolicy(manager, state),
      A,
      "src/README.md",
    );
    const outcome = ok(
      manager.request(held.state, { sessionId: B, path: "SRC/readme.md" }),
    );
    expect(outcome.result.kind).toBe("waiting");
  });

  it("refuses a path that escapes the workspace", () => {
    const { manager, state } = setup();
    expect(
      refusal(manager.request(state, { sessionId: A, path: "../outside" }))
        .reason,
    ).toBe("invalid_path");
  });

  it("lets unrelated subtrees be held concurrently", () => {
    const { manager, state } = setup();
    const first = granted(manager, state, A, "src/api");
    const second = granted(manager, first.state, B, "src/ui");
    expect(violatesSingleWriter(second.state)).toEqual([]);
    expect(
      manager.checkWrite(second.state, sessionAuthor(B), "src/ui/app.tsx")
        .allowed,
    ).toBe(true);
    expect(
      manager.checkWrite(second.state, sessionAuthor(B), "src/api/route.ts")
        .allowed,
    ).toBe(false);
  });
});

describe("grant authority follows the path hierarchy, not lineage", () => {
  it("lets whoever holds a path grant inside it, to a session of no relation", () => {
    const { manager, state } = setup();
    const held = granted(manager, state, A, "src");
    const declared = ok(
      manager.declarePolicy(held.state, {
        claimId: held.claim.id,
        subtree: "src",
        effect: "allow",
        by: sessionAuthor(A),
      }),
    );

    const outcome = ok(
      manager.request(declared.state, { sessionId: C, path: "src/auth.ts" }),
    );
    expect(outcome.result.kind).toBe("granted");
    if (outcome.result.kind !== "granted") return;
    expect(outcome.result.claim.grantedFromClaimId).toBe(held.claim.id);
    expect(outcome.result.claim.grantedBy).toEqual(sessionAuthor(A));
  });

  it("resolves two unrelated sessions to the root holder with no special case", () => {
    const { manager, state, root } = setup();
    const first = granted(manager, state, A, "src/api");
    const second = granted(manager, first.state, B, "src/ui");
    expect(first.claim.grantedFromClaimId).toBe(root.id);
    expect(second.claim.grantedFromClaimId).toBe(root.id);
  });

  it("refuses a policy declared by someone who is not the holder", () => {
    const { manager, state } = setup();
    const held = granted(manager, state, A, "src");
    expect(
      refusal(
        manager.declarePolicy(held.state, {
          claimId: held.claim.id,
          subtree: "src",
          effect: "allow",
          by: sessionAuthor(B),
        }),
      ).reason,
    ).toBe("not_holder");
  });

  it("refuses a policy wider than what the declaring claim holds (principle 1)", () => {
    const { manager, state } = setup();
    const held = granted(manager, state, A, "src");
    expect(
      refusal(
        manager.declarePolicy(held.state, {
          claimId: held.claim.id,
          subtree: ".",
          effect: "allow",
          by: sessionAuthor(A),
        }),
      ).reason,
    ).toBe("exceeds_grant");
  });

  it("refuses to grant over a path a session holds, and points at force-release", () => {
    const { manager, state } = setup();
    const held = granted(manager, state, A, "src/auth.ts");

    const over = refusal(
      manager.grant(held.state, { path: "src", to: B, by: humanAuthor }),
    );
    expect(over.reason).toBe("already_held");
    expect(over.message).toContain("force-release");

    const forced = ok(
      manager.forceRelease(held.state, {
        claimId: held.claim.id,
        by: humanAuthor,
      }),
    );
    const after = granted(manager, forced.state, B, "src");
    expect(after.claim.holder).toEqual(sessionAuthor(B));
  });

  it("refuses to grant over a live holder even when a deny policy is in force", () => {
    // Adversarial repro: a deny policy used to short-circuit the availability
    // check, so the operator's override landed on top of a live holder — two live
    // claims on one path, the first holder silently losing authority, and no
    // release effect for anyone to see (principle 4).
    const { manager, state } = setup();
    const held = granted(manager, state, A, "migrations");
    const denied = ok(
      manager.declarePolicy(held.state, {
        claimId: (rootClaimOf(held.state) as Claim).id,
        subtree: "migrations",
        effect: "deny",
        by: humanAuthor,
      }),
    );

    const stomp = manager.grant(denied.state, {
      path: "migrations",
      to: B,
      by: humanAuthor,
    });
    expect(stomp.ok).toBe(false);
    if (stomp.ok) return;
    expect(stomp.refusal.reason).toBe("already_held");
    expect(stomp.refusal.message).toContain("force-release");

    // The state is untouched: A still holds it, alone.
    expect(
      manager.checkWrite(denied.state, sessionAuthor(A), "migrations/0001.sql")
        .allowed,
    ).toBe(true);
    expect(
      manager.checkWrite(denied.state, sessionAuthor(B), "migrations/0001.sql")
        .allowed,
    ).toBe(false);
    expect(violatesSingleWriter(denied.state)).toEqual([]);

    // Force-release first, then the operator's override works as documented.
    const forced = ok(
      manager.forceRelease(denied.state, {
        claimId: held.claim.id,
        by: humanAuthor,
      }),
    );
    const after = granted(manager, forced.state, B, "migrations");
    expect(after.claim.grantedBy).toEqual(humanAuthor);
    expect(violatesSingleWriter(after.state)).toEqual([]);
  });

  it("lets the operator carve a sub-path out of a holder, narrowing its extent", () => {
    const { manager, state } = setup();
    const held = granted(manager, state, A, "src");
    const carved = granted(manager, held.state, B, "src/auth.ts");

    expect(carved.claim.grantedBy).toEqual(humanAuthor);
    expect(carved.claim.grantedFromClaimId).toBe(held.claim.id);
    // One writer per path still holds — the boundary moved, it did not blur.
    expect(
      manager.checkWrite(carved.state, sessionAuthor(A), "src/auth.ts").allowed,
    ).toBe(false);
    expect(
      manager.checkWrite(carved.state, sessionAuthor(A), "src/other.ts")
        .allowed,
    ).toBe(true);
    expect(
      manager.checkWrite(carved.state, sessionAuthor(B), "src/auth.ts").allowed,
    ).toBe(true);
    expect(violatesSingleWriter(carved.state)).toEqual([]);
  });

  it("keeps force-release to the operator: it is their escape hatch", () => {
    const { manager, state } = setup();
    const held = granted(manager, state, A, "src");
    expect(
      refusal(
        manager.forceRelease(held.state, {
          claimId: held.claim.id,
          by: sessionAuthor(B),
        }),
      ).reason,
    ).toBe("human_only");
  });

  it("refuses a session's attempt to grant directly", () => {
    const { manager, state } = setup();
    expect(
      refusal(
        manager.grant(state, { path: "src", to: B, by: sessionAuthor(A) }),
      ).reason,
    ).toBe("human_only");
  });
});

describe("pre-granted claim policies", () => {
  it("grants without a round trip where a holder said children may claim freely", () => {
    const { manager, state } = setup();
    const held = granted(manager, state, A, ".");
    const declared = ok(
      manager.declarePolicy(held.state, {
        claimId: held.claim.id,
        subtree: "src",
        effect: "allow",
        by: sessionAuthor(A),
      }),
    );

    let current = declared.state;
    for (const path of ["src/a.ts", "src/b.ts", "src/deep/c.ts"]) {
      const outcome = ok(manager.request(current, { sessionId: B, path }));
      expect(outcome.result.kind).toBe("granted");
      current = outcome.state;
    }
    // Twenty files, zero paid round trips — the §3.4 economics test.
    expect(claimsHeldBy(current, sessionAuthor(B))).toHaveLength(3);
  });

  it("refuses inside a denied subtree, and says which policy closed it", () => {
    const { manager, state } = setup();
    const held = granted(manager, state, A, ".");
    let current = ok(
      manager.declarePolicy(held.state, {
        claimId: held.claim.id,
        subtree: ".",
        effect: "allow",
        by: sessionAuthor(A),
      }),
    ).state;
    current = ok(
      manager.declarePolicy(current, {
        claimId: held.claim.id,
        subtree: "migrations",
        effect: "deny",
        by: sessionAuthor(A),
      }),
    ).state;

    const denied = refusal(
      manager.request(current, { sessionId: B, path: "migrations/0007.sql" }),
    );
    expect(denied.reason).toBe("policy_denied");
    expect(denied.message).toContain("migrations");

    // Deny is scoped, not global: the allow still stands elsewhere.
    expect(
      ok(manager.request(current, { sessionId: B, path: "src/a.ts" })).result
        .kind,
    ).toBe("granted");
  });

  it("consults the whole grant chain's policies, not just the immediate grantor's", () => {
    const { manager, state } = setup();
    const rootHeld = granted(manager, state, A, ".");
    let current = ok(
      manager.declarePolicy(rootHeld.state, {
        claimId: rootHeld.claim.id,
        subtree: "migrations",
        effect: "deny",
        by: sessionAuthor(A),
      }),
    ).state;

    // A sub-holder that allows everything under its own path cannot re-open what
    // an ancestor closed: deny wins, at any depth.
    const sub = granted(manager, current, B, "migrations");
    current = ok(
      manager.declarePolicy(sub.state, {
        claimId: sub.claim.id,
        subtree: "migrations",
        effect: "allow",
        by: sessionAuthor(B),
      }),
    ).state;

    expect(
      refusal(
        manager.request(current, { sessionId: C, path: "migrations/x.sql" }),
      ).reason,
    ).toBe("policy_denied");
  });

  it("drops the policies a claim declared when the claim goes", () => {
    const { manager, state } = setup();
    const held = granted(manager, state, A, "src");
    const declared = ok(
      manager.declarePolicy(held.state, {
        claimId: held.claim.id,
        subtree: "src",
        effect: "allow",
        by: sessionAuthor(A),
      }),
    );
    const ended = ok(manager.endSession(declared.state, A));
    expect(ended.state.policies).toEqual([]);
    expect(
      ended.effects.some(
        (effect) =>
          effect.kind === "policy-withdrawn" &&
          effect.reason === "claim-released",
      ),
    ).toBe(true);
  });
});

describe("approvals for claims outside every standing policy (§6.6)", () => {
  it("waits on the grantor, and grants when the grantor says yes", () => {
    const { manager, state } = setup();
    const held = granted(manager, state, A, "src");
    const asked = ok(
      manager.request(held.state, { sessionId: B, path: "src/auth.ts" }),
    );
    expect(asked.result.kind).toBe("approval-required");
    if (asked.result.kind !== "approval-required") return;
    expect(
      asked.effects.some((effect) => effect.kind === "approval-required"),
    ).toBe(true);

    const answered = ok(
      manager.answerApproval(asked.state, {
        waitId: asked.result.wait.id,
        by: sessionAuthor(A),
        decision: "grant",
      }),
    );
    expect(answered.result.kind).toBe("granted");
    expect(answered.state.waits).toEqual([]);
  });

  it("lets the operator answer in the grantor's place, and refuses anyone else", () => {
    const { manager, state } = setup();
    const held = granted(manager, state, A, "src");
    const asked = ok(
      manager.request(held.state, { sessionId: B, path: "src/auth.ts" }),
    );
    if (asked.result.kind !== "approval-required")
      throw new Error("expected an approval");

    expect(
      refusal(
        manager.answerApproval(asked.state, {
          waitId: asked.result.wait.id,
          by: sessionAuthor(C),
          decision: "grant",
        }),
      ).reason,
    ).toBe("not_holder");

    const byOperator = ok(
      manager.answerApproval(asked.state, {
        waitId: asked.result.wait.id,
        by: humanAuthor,
        decision: "grant",
      }),
    );
    expect(byOperator.result.kind).toBe("granted");
  });

  it("records a denial as an answer, not as a silent drop", () => {
    const { manager, state } = setup();
    const held = granted(manager, state, A, "src");
    const asked = ok(
      manager.request(held.state, { sessionId: B, path: "src/auth.ts" }),
    );
    if (asked.result.kind !== "approval-required")
      throw new Error("expected an approval");

    const denied = ok(
      manager.answerApproval(asked.state, {
        waitId: asked.result.wait.id,
        by: sessionAuthor(A),
        decision: "deny",
      }),
    );
    expect(denied.result).toEqual({
      kind: "denied",
      waitId: asked.result.wait.id,
    });
    expect(denied.effects).toEqual([
      { kind: "wait-removed", waitId: asked.result.wait.id, reason: "refused" },
    ]);
  });

  it("keeps the waiter's place when the path was taken before the answer came", () => {
    const { manager, state, clock } = setup();
    const held = granted(manager, state, A, "src");
    const asked = ok(
      manager.request(held.state, { sessionId: B, path: "src/auth.ts" }),
    );
    if (asked.result.kind !== "approval-required")
      throw new Error("expected an approval");

    // While the approval sat unanswered, the operator handed the path to C.
    clock.tick(30);
    const taken = granted(manager, asked.state, C, "src/auth.ts");

    const answered = ok(
      manager.answerApproval(taken.state, {
        waitId: asked.result.wait.id,
        by: sessionAuthor(A),
        decision: "grant",
      }),
    );
    // Authorized now, still unavailable: the wait survives as a held-wait, so
    // freeing the path grants it without asking A a second time.
    expect(answered.result.kind).toBe("waiting");
    expect(answered.state.waits[0]?.authorizedAt).toBe(clock());

    const freed = ok(manager.endSession(answered.state, C, clock.tick(5)));
    expect(freed.state.waits).toEqual([]);
    expect(claimsHeldBy(freed.state, sessionAuthor(B))).toHaveLength(1);
  });

  it("grants a pending approval the moment a policy covers it", () => {
    const { manager, state } = setup();
    const asked = ok(
      manager.request(state, { sessionId: B, path: "src/auth.ts" }),
    );
    expect(asked.result.kind).toBe("approval-required");

    // The operator pre-grants the subtree rather than answering one request at a
    // time — §6.6's pre-granted approval, expressed as a policy.
    const declared = ok(
      manager.declarePolicy(asked.state, {
        claimId: (rootClaimOf(asked.state) as Claim).id,
        subtree: "src",
        effect: "allow",
        by: humanAuthor,
      }),
    );
    expect(declared.state.waits).toEqual([]);
    expect(claimsHeldBy(declared.state, sessionAuthor(B))).toHaveLength(1);
  });

  it("re-raises the approval against the new authority when the grantor's claim goes", () => {
    const { manager, state } = setup();
    const held = granted(manager, state, A, "src");
    const asked = ok(
      manager.request(held.state, { sessionId: B, path: "src/auth.ts" }),
    );
    if (asked.result.kind !== "approval-required")
      throw new Error("expected an approval");

    const ended = ok(manager.endSession(asked.state, A));
    const reraised = ended.effects.filter(
      (effect) => effect.kind === "approval-required",
    );
    expect(reraised).toHaveLength(1);
    expect(ended.state.waits[0]?.grantorClaimId).toBe(
      rootClaimOf(ended.state)?.id,
    );
  });
});

describe("leases, not locks", () => {
  it("expires a claim after inactivity and frees the path", () => {
    const { manager, state, clock } = setup(600);
    const held = granted(manager, state, A, "src");

    const early = ok(manager.expire(held.state, clock.tick(599)));
    expect(early.result.expired).toEqual([]);

    const lapsed = ok(manager.expire(early.state, clock.tick(1)));
    expect(lapsed.result.expired).toEqual([held.claim.id]);
    expect(
      lapsed.effects.some(
        (effect) =>
          effect.kind === "claim-released" && effect.reason === "expired",
      ),
    ).toBe(true);
    expect(
      manager.checkWrite(lapsed.state, sessionAuthor(A), "src/a.ts").allowed,
    ).toBe(false);
  });

  it("is renewed by activity inside the claim", () => {
    const { manager, state, clock } = setup(600);
    const held = granted(manager, state, A, "src");

    const wrote = ok(
      manager.recordWrite(held.state, {
        actor: sessionAuthor(A),
        path: "src/auth.ts",
        at: clock.tick(500),
      }),
    );
    expect(wrote.result.write.claimId).toBe(held.claim.id);

    const later = ok(manager.expire(wrote.state, clock.tick(599)));
    expect(later.result.expired).toEqual([]);
  });

  it("renews only the claims covering the path the activity happened in", () => {
    const { manager, state, clock } = setup(600);
    const api = granted(manager, state, A, "src/api");
    const docs = granted(manager, api.state, A, "docs");

    const active = ok(
      manager.recordActivity(docs.state, {
        sessionId: A,
        path: "docs/readme.md",
        at: clock.tick(500),
      }),
    );
    expect(active.result.renewed).toEqual([docs.claim.id]);

    const lapsed = ok(manager.expire(active.state, clock.tick(200)));
    expect(lapsed.result.expired).toEqual([api.claim.id]);
  });

  it("lets a still-working holder renew explicitly, and nobody else", () => {
    const { manager, state, clock } = setup(600);
    const held = granted(manager, state, A, "src");
    expect(
      refusal(
        manager.renew(held.state, {
          claimId: held.claim.id,
          by: sessionAuthor(B),
        }),
      ).reason,
    ).toBe("not_holder");

    const renewed = ok(
      manager.renew(held.state, {
        claimId: held.claim.id,
        by: sessionAuthor(A),
        at: clock.tick(300),
      }),
    );
    expect(renewed.result.claim.lastActivityAt).toBe(clock());
  });

  it("defaults the lease to fifteen minutes", () => {
    const clock = testClock();
    const manager = createClaimManager({ clock, ids: countingClaimIds() });
    const opened = manager.open(ws());
    const held = granted(manager, opened.state, A, "src");
    expect(held.claim.leaseSeconds).toBe(DEFAULT_CLAIM_LEASE_SECONDS);
  });

  it("leases a claim granted off the waitlist, and expires it like any other", () => {
    // Adversarial repro: an unspecified lease was stored as null on the wait and
    // passed straight through on promotion, where null means never-expires — so a
    // claim nobody asked to be permanent became a lock only the operator could
    // break. Leases, not locks (§3.4).
    const { manager, state, clock } = setup(600);
    const held = granted(manager, openWithRootPolicy(manager, state), A, "src");
    const waiting = ok(
      manager.request(held.state, { sessionId: B, path: "src" }),
    );
    expect(waiting.result.kind).toBe("waiting");

    const ended = ok(manager.endSession(waiting.state, A, clock.tick(10)));
    const promoted = claimsHeldBy(ended.state, sessionAuthor(B))[0] as Claim;
    expect(promoted.leaseSeconds).toBe(600);
    expect(violatesLeasePolicy(ended.state)).toEqual([]);

    const lapsed = ok(manager.expire(ended.state, clock.tick(600)));
    expect(lapsed.result.expired).toEqual([promoted.id]);
  });

  it("leases a claim granted by answering an approval", () => {
    const { manager, state, clock } = setup(600);
    const held = granted(manager, state, A, "src");
    const asked = ok(
      manager.request(held.state, { sessionId: B, path: "src/auth.ts" }),
    );
    if (asked.result.kind !== "approval-required") {
      throw new Error("expected an approval");
    }

    const answered = ok(
      manager.answerApproval(asked.state, {
        waitId: asked.result.wait.id,
        by: sessionAuthor(A),
        decision: "grant",
        at: clock.tick(5),
      }),
    );
    if (answered.result.kind !== "granted") throw new Error("expected a grant");
    const grantedClaim = answered.result.claim;
    expect(grantedClaim.leaseSeconds).toBe(600);
    expect(violatesLeasePolicy(answered.state)).toEqual([]);

    // A's own claim lapses in the same sweep — it has been idle just as long —
    // so this asserts the new claim is *among* the expired rather than pinning
    // the whole sweep.
    const lapsed = ok(manager.expire(answered.state, clock.tick(600)));
    expect(lapsed.result.expired).toContain(grantedClaim.id);
    expect(
      lapsed.state.claims.some((claim) => claim.id === grantedClaim.id),
    ).toBe(false);
  });

  it("carries an explicitly requested lease through the waitlist unchanged", () => {
    const { manager, state, clock } = setup(600);
    const held = granted(manager, openWithRootPolicy(manager, state), A, "src");
    const waiting = ok(
      manager.request(held.state, {
        sessionId: B,
        path: "src",
        leaseSeconds: 60,
      }),
    );
    expect(waiting.result.kind).toBe("waiting");

    const ended = ok(manager.endSession(waiting.state, A, clock.tick(10)));
    const promoted = claimsHeldBy(ended.state, sessionAuthor(B))[0] as Claim;
    expect(promoted.leaseSeconds).toBe(60);
  });

  it("keeps the root claim the only immortal one", () => {
    const { manager, state } = setup();
    const held = granted(manager, state, A, "src");
    expect(violatesLeasePolicy(held.state)).toEqual([]);
    expect(
      held.state.claims.filter((claim) => claim.leaseSeconds === null),
    ).toEqual([rootClaimOf(held.state)]);
  });

  it("refuses a write from a session whose lease lapsed, naming who holds it now", () => {
    const { manager, state, clock } = setup(600);
    const held = granted(manager, state, A, "src");
    const lapsed = ok(manager.expire(held.state, clock.tick(600)));
    const taken = granted(manager, lapsed.state, B, "src");

    const check = manager.checkWrite(
      taken.state,
      sessionAuthor(A),
      "src/auth.ts",
    );
    expect(check.allowed).toBe(false);
    if (check.allowed) return;
    expect(check.refusal.message).toContain(B);
  });

  it("refuses to record a write nobody holds the path for", () => {
    const { manager, state } = setup();
    expect(
      refusal(
        manager.recordWrite(state, {
          actor: sessionAuthor(A),
          path: "src/a.ts",
        }),
      ).reason,
    ).toBe("not_holder");
  });
});

describe("release, waitlists, and automatic cleanup", () => {
  it("releases everything a session held when it ends, and drops its own waits", () => {
    const { manager, state } = setup();
    const held = granted(manager, openWithRootPolicy(manager, state), A, "src");
    const waiting = ok(
      manager.request(held.state, { sessionId: B, path: "src" }),
    );
    if (waiting.result.kind !== "waiting") throw new Error("expected a wait");

    const ended = ok(manager.endSession(waiting.state, A));
    expect(ended.result.released).toEqual([held.claim.id]);
    // B's wait was next in line and already authorized by policy, so ending A
    // promoted it with no second round trip.
    expect(ended.state.waits).toEqual([]);
    expect(claimsHeldBy(ended.state, sessionAuthor(B))).toHaveLength(1);
  });

  it("promotes the waitlist in the order sessions joined it", () => {
    const { manager, state, clock } = setup();
    const held = granted(manager, openWithRootPolicy(manager, state), A, "src");
    let current = ok(
      manager.request(held.state, {
        sessionId: B,
        path: "src",
        at: clock.tick(1),
      }),
    ).state;
    current = ok(
      manager.request(current, {
        sessionId: C,
        path: "src",
        at: clock.tick(1),
      }),
    ).state;

    const inspected = manager.inspect(current, { sessionId: C });
    expect(inspected.waiting[0]?.position).toBe(2);

    const ended = ok(manager.endSession(current, A, clock.tick(1)));
    expect(claimsHeldBy(ended.state, sessionAuthor(B))).toHaveLength(1);
    // C stays waiting, now blocked by B rather than by A.
    expect(ended.state.waits).toHaveLength(1);
    expect(ended.state.waits[0]?.sessionId).toBe(C);
    expect(ended.state.waits[0]?.blockedByClaimIds).toEqual(
      claimsHeldBy(ended.state, sessionAuthor(B)).map((claim) => claim.id),
    );
  });

  it("lets a holder yield explicitly as an optimization, and nobody else yield for it", () => {
    const { manager, state } = setup();
    const held = granted(manager, state, A, "src");
    expect(
      refusal(
        manager.yieldClaim(held.state, {
          claimId: held.claim.id,
          by: sessionAuthor(B),
        }),
      ).reason,
    ).toBe("not_holder");

    const yielded = ok(
      manager.yieldClaim(held.state, {
        claimId: held.claim.id,
        by: sessionAuthor(A),
      }),
    );
    expect(yielded.result.released).toBe(held.claim.id);
    expect(claimsHeldBy(yielded.state, sessionAuthor(A))).toEqual([]);
  });

  it("reattaches sub-claims when their grantor goes, rather than punishing the children", () => {
    const { manager, state, root } = setup();
    const parent = granted(manager, state, A, "src");
    const allowed = ok(
      manager.declarePolicy(parent.state, {
        claimId: parent.claim.id,
        subtree: "src",
        effect: "allow",
        by: sessionAuthor(A),
      }),
    );
    const child = ok(
      manager.request(allowed.state, { sessionId: B, path: "src/auth.ts" }),
    );
    if (child.result.kind !== "granted") throw new Error("expected a grant");
    const childClaimId = child.result.claim.id;

    const ended = ok(manager.endSession(child.state, A));
    const survivor = ended.state.claims.find(
      (claim) => claim.id === childClaimId,
    );
    expect(survivor?.grantedFromClaimId).toBe(root.id);
    expect(
      manager.checkWrite(ended.state, sessionAuthor(B), "src/auth.ts").allowed,
    ).toBe(true);
    expect(violatesGrantExtent(ended.state)).toEqual([]);
  });

  it("takes sub-claims with it when the operator revokes with cascade", () => {
    const { manager, state } = setup();
    const parent = granted(manager, state, A, "src");
    const child = granted(manager, parent.state, B, "src/auth.ts");

    const revoked = ok(
      manager.forceRelease(child.state, {
        claimId: parent.claim.id,
        by: humanAuthor,
        cascade: true,
      }),
    );
    expect(new Set(revoked.result.released)).toEqual(
      new Set([parent.claim.id, child.claim.id]),
    );
    expect(revoked.state.claims).toHaveLength(1);
    expect(
      revoked.effects.some(
        (effect) =>
          effect.kind === "claim-released" && effect.reason === "revoked",
      ),
    ).toBe(true);
  });

  it("returns the place in the queue a retried request already has (principle 9)", () => {
    const { manager, state, clock } = setup();
    const held = granted(manager, state, A, "src");
    const first = ok(
      manager.request(held.state, { sessionId: B, path: "src" }),
    );
    const again = ok(
      manager.request(first.state, {
        sessionId: B,
        path: "src",
        at: clock.tick(30),
      }),
    );

    expect(again.state.waits).toHaveLength(1);
    expect(again.effects).toEqual([]);
    if (first.result.kind !== "waiting" || again.result.kind !== "waiting")
      return;
    expect(again.result.wait.id).toBe(first.result.wait.id);
  });

  it("lets a waiting session withdraw its own place, and nobody else's", () => {
    const { manager, state } = setup();
    const held = granted(manager, openWithRootPolicy(manager, state), A, "src");
    const waiting = ok(
      manager.request(held.state, { sessionId: B, path: "src" }),
    );
    if (waiting.result.kind !== "waiting") throw new Error("expected a wait");

    expect(
      refusal(
        manager.withdrawWait(waiting.state, {
          waitId: waiting.result.wait.id,
          by: sessionAuthor(C),
        }),
      ).reason,
    ).toBe("not_holder");

    const withdrawn = ok(
      manager.withdrawWait(waiting.state, {
        waitId: waiting.result.wait.id,
        by: sessionAuthor(B),
      }),
    );
    expect(withdrawn.state.waits).toEqual([]);
  });
});

describe("waiting as visible state (§3.4, §7.2)", () => {
  it("reports position, how long, who blocks, and what everyone else holds", () => {
    const { manager, state, clock } = setup();
    const held = granted(manager, state, A, "src");
    const waiting = ok(
      manager.request(held.state, {
        sessionId: B,
        path: "src",
        at: clock.tick(10),
      }),
    );

    const view = manager.inspect(waiting.state, {
      sessionId: B,
      at: clock.tick(400),
    });
    expect(view.waiting).toHaveLength(1);
    expect(view.waiting[0]?.position).toBe(1);
    expect(view.waiting[0]?.waitingForSeconds).toBe(400);
    expect(view.waiting[0]?.blockedBy.map((claim) => claim.id)).toEqual([
      held.claim.id,
    ]);
    expect(view.waiting[0]?.pastAlertThreshold).toBe(true);
    expect(
      view.othersHold.some((claim) => isHeldBy(claim, sessionAuthor(A))),
    ).toBe(true);
    expect(view.held).toEqual([]);
  });

  it("feeds blocked-on accounting, separating a human answer from a session's", () => {
    const { manager, state, clock } = setup();
    // `src` is pre-granted by policy; `docs` is not.
    const declared = ok(
      manager.declarePolicy(state, {
        claimId: (rootClaimOf(state) as Claim).id,
        subtree: "src",
        effect: "allow",
        by: humanAuthor,
      }),
    );
    const heldByA = granted(manager, declared.state, A, "src");
    // B is authorized for `src` and only waiting for A: blocked on a session.
    const onSession = ok(
      manager.request(heldByA.state, { sessionId: B, path: "src" }),
    );
    // C asks for a path no policy covers: blocked on the operator's answer.
    const onHuman = ok(
      manager.request(onSession.state, { sessionId: C, path: "docs" }),
    );

    const metrics = manager.waitMetrics(onHuman.state, { at: clock.tick(120) });
    expect(metrics.waits).toHaveLength(2);
    expect(metrics.blockedOnHumanSeconds).toBeGreaterThan(0);
    expect(metrics.blockedOnSessionSeconds).toBeGreaterThan(0);
    expect(
      metrics.waits.find((wait) => wait.sessionId === C)?.blockedOnHuman,
    ).toBe(true);
    expect(
      metrics.waits.find((wait) => wait.sessionId === B)?.blockedOnHuman,
    ).toBe(false);
  });

  it("reports overlapping waitlisted paths — §7.2's intra-workstream conflict signal", () => {
    const { manager, state } = setup();
    const held = granted(manager, state, A, "src");
    let current = ok(
      manager.request(held.state, { sessionId: B, path: "src/auth.ts" }),
    ).state;
    current = ok(
      manager.request(current, { sessionId: C, path: "src/auth.ts" }),
    ).state;

    const metrics = manager.waitMetrics(current);
    expect(metrics.overlapping).toHaveLength(1);
    expect(new Set(metrics.overlapping[0]?.sessionIds)).toEqual(
      new Set([B, C]),
    );
  });

  it("answers the §3.6 waiting-on-claim phase input", () => {
    const { manager, state } = setup();
    const held = granted(manager, state, A, "src");
    const waiting = ok(
      manager.request(held.state, { sessionId: B, path: "src" }),
    );
    expect(manager.isWaitingOnClaim(waiting.state, B)).toBe(true);
    expect(manager.isWaitingOnClaim(waiting.state, A)).toBe(false);
  });
});

describe("the operator as an implicit claim holder", () => {
  it("may write any path, claimed or not", () => {
    const { manager, state } = setup();
    const held = granted(manager, state, A, "src");
    expect(
      manager.checkWrite(held.state, humanAuthor, "src/auth.ts").allowed,
    ).toBe(true);
    expect(
      manager.checkWrite(held.state, humanAuthor, "untouched/file.md").allowed,
    ).toBe(true);
  });

  it("records a hand edit against no claim at all", () => {
    const { manager, state } = setup();
    const held = granted(manager, state, A, "src");
    const wrote = ok(
      manager.recordWrite(held.state, {
        actor: humanAuthor,
        path: "src/auth.ts",
      }),
    );
    expect(wrote.result.write.claimId).toBeNull();
    expect(wrote.result.write.holder).toEqual(humanAuthor);
    // A hand edit does not renew anyone's lease.
    expect(wrote.effects).toEqual([]);
  });
});

describe("the capability invariant (why this is consistent with principle 1)", () => {
  it("never lets a grant exceed the granter's own extent", () => {
    const { manager, state } = setup();
    const held = granted(manager, state, A, "src/api");
    const allowed = ok(
      manager.declarePolicy(held.state, {
        claimId: held.claim.id,
        subtree: "src/api",
        effect: "allow",
        by: sessionAuthor(A),
      }),
    );

    // B asking for something outside A's extent resolves to the *root* holder,
    // never to A — a claim redistributes reach, it never creates any.
    const outside = ok(
      manager.request(allowed.state, { sessionId: B, path: "src/ui" }),
    );
    expect(outside.result.kind).toBe("approval-required");
    if (outside.result.kind !== "approval-required") return;
    expect(outside.result.grantor).toEqual(humanAuthor);
    expect(violatesGrantExtent(outside.state)).toEqual([]);
  });

  it("keeps every claim inside its granter's path through releases and promotions", () => {
    const { manager, state } = setup();
    const parent = granted(manager, state, A, "src");
    const child = granted(manager, parent.state, B, "src/api");
    const grandchild = granted(manager, child.state, C, "src/api/handlers");

    const ended = ok(manager.endSession(grandchild.state, B));
    expect(violatesGrantExtent(ended.state)).toEqual([]);
    expect(violatesSingleWriter(ended.state)).toEqual([]);
  });
});

describe("an unopened workstream", () => {
  it("refuses everything rather than inventing an authority", () => {
    const manager = createClaimManager({
      clock: testClock(),
      ids: countingClaimIds(),
    });
    const empty: ClaimState = {
      workstreamId: ws(),
      claims: [],
      waits: [],
      policies: [],
    };
    expect(
      refusal(manager.request(empty, { sessionId: A, path: "src" })).reason,
    ).toBe("no_such_claim");
    expect(manager.checkWrite(empty, sessionAuthor(A), "src").allowed).toBe(
      false,
    );
  });
});
