import { describe, expect, it } from "vitest";

import { humanAuthor, sessionAuthor } from "../author.js";
import { findAnyWaitCycle, waitForEdges } from "./deadlock.js";
import { createClaimManager, type ClaimManager } from "./manager.js";
import {
  rootClaimOf,
  type Claim,
  type ClaimEffect,
  type ClaimOutcome,
  type ClaimState,
} from "./model.js";
import { countingClaimIds, session, testClock, ws } from "./testing.js";

/**
 * §3.4: "A holds `src/api/` and waits on `src/ui/`; B holds `src/ui/` and waits
 * on `src/api/`. The claim manager detects the wait-for cycle and refuses the
 * newest claim with an actionable message."
 */

const A = session("sess_a");
const B = session("sess_b");
const C = session("sess_c");

function setup() {
  const clock = testClock();
  const manager = createClaimManager({ clock, ids: countingClaimIds() });
  const opened = manager.open(ws());
  // Everything pre-granted, so these tests are about the wait-for graph rather
  // than about approvals.
  const declared = manager.declarePolicy(opened.state, {
    claimId: (rootClaimOf(opened.state) as Claim).id,
    subtree: ".",
    effect: "allow",
    by: humanAuthor,
  });
  if (!declared.ok) throw new Error(declared.refusal.message);
  return { clock, manager, state: declared.state };
}

function must<T>(outcome: ClaimOutcome<T>): {
  state: ClaimState;
  result: T;
  effects: readonly ClaimEffect[];
} {
  if (!outcome.ok) throw new Error(`refused: ${outcome.refusal.message}`);
  return {
    state: outcome.state,
    result: outcome.result,
    effects: outcome.effects,
  };
}

function hold(
  manager: ClaimManager,
  state: ClaimState,
  sessionId: typeof A,
  path: string,
): ClaimState {
  const outcome = must(manager.request(state, { sessionId, path }));
  if (outcome.result.kind !== "granted") {
    throw new Error(`expected a grant, got ${outcome.result.kind}`);
  }
  return outcome.state;
}

describe("wait-for cycles", () => {
  it("refuses the newest claim in a two-party cycle, naming what the requester holds", () => {
    const { manager, state } = setup();
    let current = hold(manager, state, A, "src/api");
    current = hold(manager, current, B, "src/ui");

    // B joins the queue for A's path: no cycle yet, so it waits.
    const waiting = must(
      manager.request(current, { sessionId: B, path: "src/api" }),
    );
    expect(waiting.result.kind).toBe("waiting");

    // A now asks for B's path, which would close the loop.
    const closing = manager.request(waiting.state, {
      sessionId: A,
      path: "src/ui",
    });
    expect(closing.ok).toBe(false);
    if (closing.ok) return;
    expect(closing.refusal.reason).toBe("would_deadlock");
    expect(closing.refusal.message).toContain("src/api");
    expect(closing.refusal.message).toContain("yield one of those");
    expect(closing.refusal.details?.youHold).toEqual(["src/api"]);
  });

  it("detects a three-party cycle", () => {
    const { manager, state } = setup();
    let current = hold(manager, state, A, "x");
    current = hold(manager, current, B, "y");
    current = hold(manager, current, C, "z");

    current = must(manager.request(current, { sessionId: B, path: "x" })).state;
    current = must(manager.request(current, { sessionId: C, path: "y" })).state;

    const closing = manager.request(current, { sessionId: A, path: "z" });
    expect(closing.ok).toBe(false);
    if (closing.ok) return;
    expect(closing.refusal.reason).toBe("would_deadlock");
    expect((closing.refusal.details?.cycle as unknown[]).length).toBe(3);
  });

  it("counts an unanswered approval as a wait on the grantor", () => {
    const clock = testClock();
    const manager = createClaimManager({ clock, ids: countingClaimIds() });
    const opened = manager.open(ws());
    // No blanket policy here: B's request inside A's path needs A's answer, which
    // is a wait on A just as surely as a held path is.
    let current = must(
      manager.grant(opened.state, { path: "src", to: A, by: humanAuthor }),
    ).state;
    current = must(
      manager.grant(current, { path: "docs", to: B, by: humanAuthor }),
    ).state;

    const asked = must(
      manager.request(current, { sessionId: B, path: "src/auth.ts" }),
    );
    expect(asked.result.kind).toBe("approval-required");

    const closing = manager.request(asked.state, {
      sessionId: A,
      path: "docs",
    });
    expect(closing.ok).toBe(false);
    if (closing.ok) return;
    expect(closing.refusal.reason).toBe("would_deadlock");
  });

  it("refuses the newest wait when an immediate grant closes the cycle", () => {
    // Adversarial repro (the grant-path variant): nothing is promoted and nothing
    // is released here — a session simply takes a free path, and that claim is
    // what another waiter was implicitly blocked by. The immediate-grant branch
    // skipped the sweep while the operator's grant did not, so the cycle stood
    // live *and* the waiter's stored blockers were stale, which hid it from the
    // claims panel as well as from detection.
    const { manager, state, clock } = setup();
    let current = hold(manager, state, C, "src/api");
    current = hold(manager, current, B, "docs");

    // B queues for `src`, blocked by C's claim inside it.
    const bWaits = must(
      manager.request(current, {
        sessionId: B,
        path: "src",
        at: clock.tick(1),
      }),
    );
    expect(bWaits.result.kind).toBe("waiting");
    // A queues for `docs`, which B holds: A -> B.
    const aWaits = must(
      manager.request(bWaits.state, {
        sessionId: A,
        path: "docs",
        at: clock.tick(1),
      }),
    );
    expect(aWaits.result.kind).toBe("waiting");
    expect(findAnyWaitCycle(waitForEdges(aWaits.state))).toBeNull();

    // A now takes `src/ui` — free, policy-allowed, granted at once. It sits inside
    // `src`, so B is now waiting on A too, closing B -> A -> B.
    const granted = must(
      manager.request(aWaits.state, {
        sessionId: A,
        path: "src/ui",
        at: clock.tick(1),
      }),
    );
    expect(granted.result.kind).toBe("granted");

    // Detected, and detected from the *stored* rows — which is only possible
    // because the grant resynced them.
    expect(findAnyWaitCycle(waitForEdges(granted.state))).toBeNull();
    const refused = granted.effects.filter(
      (effect) => effect.kind === "deadlock-refused",
    );
    expect(refused).toHaveLength(1);
    const [only] = refused;
    if (only?.kind !== "deadlock-refused")
      throw new Error("expected a refusal");
    // A's own wait is the newest in the loop, so A's is the one refused.
    expect(only.wait.sessionId).toBe(A);
    expect(only.message).toContain("yield one of those");

    // B keeps its place, and its stored blockers now name every live blocker
    // rather than only the one that existed when it queued.
    const bWait = granted.state.waits.find((wait) => wait.sessionId === B);
    expect(bWait).toBeDefined();
    const blockingHolders = (bWait?.blockedByClaimIds ?? []).map((claimId) => {
      const claim = granted.state.claims.find(
        (candidate) => candidate.id === claimId,
      );
      return claim?.holder.kind === "session" ? claim.holder.sessionId : "?";
    });
    expect(new Set(blockingHolders)).toEqual(new Set([A, C]));
  });

  it("resyncs stored blockers when an approval answer grants a claim", () => {
    // The same asymmetry lived in `answerApproval`'s direct-grant branch.
    const clock = testClock();
    const manager = createClaimManager({ clock, ids: countingClaimIds() });
    const opened = manager.open(ws());
    // C holds `src`, so a request inside it needs C's answer; B queues for `src`
    // itself, blocked by C.
    const current = must(
      manager.grant(opened.state, { path: "src", to: C, by: humanAuthor }),
    ).state;
    const bWaits = must(
      manager.request(current, {
        sessionId: B,
        path: "src",
        at: clock.tick(1),
      }),
    );
    const asked = must(
      manager.request(bWaits.state, {
        sessionId: A,
        path: "src/ui",
        at: clock.tick(1),
      }),
    );
    if (asked.result.kind !== "approval-required") {
      throw new Error("expected an approval");
    }

    const answered = must(
      manager.answerApproval(asked.state, {
        waitId: asked.result.wait.id,
        by: sessionAuthor(C),
        decision: "grant",
        at: clock.tick(1),
      }),
    );
    expect(answered.result.kind).toBe("granted");

    // B was waiting on `src` before A held part of it; the answer's grant is what
    // makes A a blocker, and B's row says so.
    const bWait = answered.state.waits.find((wait) => wait.sessionId === B);
    const holders = (bWait?.blockedByClaimIds ?? []).map((claimId) => {
      const claim = answered.state.claims.find(
        (candidate) => candidate.id === claimId,
      );
      return claim?.holder.kind === "session" ? claim.holder.sessionId : "?";
    });
    expect(new Set(holders)).toEqual(new Set([A, C]));
  });

  it("refuses the newest wait when promotion churn closes the cycle", () => {
    // Adversarial repro: no request closes this loop, a *promotion* does. Cycle
    // detection ran only at insertion, so both waits stood forever — B waiting
    // for A to release `y`, A waiting for B to release `w` — which is precisely
    // the endured deadlock §3.4 forbids.
    const { manager, state, clock } = setup();
    let current = hold(manager, state, A, "y");
    current = hold(manager, current, C, "w");

    // B queues behind A for `y`, and ahead of A for `w`.
    current = must(
      manager.request(current, { sessionId: B, path: "y", at: clock.tick(1) }),
    ).state;
    current = must(
      manager.request(current, { sessionId: B, path: "w", at: clock.tick(1) }),
    ).state;
    const aWaits = must(
      manager.request(current, { sessionId: A, path: "w", at: clock.tick(1) }),
    );
    expect(aWaits.result.kind).toBe("waiting");
    expect(findAnyWaitCycle(waitForEdges(aWaits.state))).toBeNull();

    // C ends. B is first in line for `w`, so B is granted it — and A's wait moves
    // onto B, closing A -> B -> A.
    const ended = must(manager.endSession(aWaits.state, C, clock.tick(1)));

    expect(findAnyWaitCycle(waitForEdges(ended.state))).toBeNull();
    const refused = ended.effects.filter(
      (effect) => effect.kind === "deadlock-refused",
    );
    expect(refused).toHaveLength(1);
    const [only] = refused;
    if (only?.kind !== "deadlock-refused")
      throw new Error("expected a refusal");
    // The newest wait goes, exactly as at insertion, and says what to yield.
    expect(only.wait.sessionId).toBe(A);
    expect(only.message).toContain("y");
    expect(only.message).toContain("yield one of those");
    expect(
      ended.effects.some(
        (effect) =>
          effect.kind === "wait-removed" && effect.reason === "deadlock",
      ),
    ).toBe(true);

    // B keeps its place in the queue for `y`; only the newest wait was refused.
    expect(ended.state.waits.map((wait) => wait.sessionId)).toEqual([B]);
  });

  it("does not refuse a chain of waits that is not a cycle", () => {
    const { manager, state } = setup();
    let current = hold(manager, state, A, "x");
    current = hold(manager, current, B, "y");

    current = must(manager.request(current, { sessionId: C, path: "y" })).state;
    const stillFine = manager.request(current, { sessionId: B, path: "x" });
    expect(stillFine.ok).toBe(true);
    if (!stillFine.ok) return;
    expect(stillFine.result.kind).toBe("waiting");
  });

  it("draws no edge to the operator, so an approval from them cannot deadlock", () => {
    const clock = testClock();
    const manager = createClaimManager({ clock, ids: countingClaimIds() });
    const opened = manager.open(ws());
    const held = must(
      manager.grant(opened.state, { path: "src", to: A, by: humanAuthor }),
    ).state;

    // A waits on the operator for `docs`; B waits on A for `src`. The operator is
    // not a node in the graph, so there is no cycle to find.
    const first = must(manager.request(held, { sessionId: A, path: "docs" }));
    const second = manager.request(first.state, { sessionId: B, path: "src" });
    expect(second.ok).toBe(true);

    if (!second.ok) return;
    const edges = waitForEdges(second.state);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.from).toBe(B);
    expect(edges[0]?.to).toBe(A);
  });

  it("lets the cycle clear once a holder yields", () => {
    const { manager, state } = setup();
    let current = hold(manager, state, A, "src/api");
    current = hold(manager, current, B, "src/ui");
    current = must(
      manager.request(current, { sessionId: B, path: "src/api" }),
    ).state;

    const aClaim = current.claims.find(
      (claim) => claim.path.display === "src/api",
    ) as Claim;
    const yielded = must(
      manager.yieldClaim(current, { claimId: aClaim.id, by: sessionAuthor(A) }),
    );
    // B's wait was authorized by policy, so yielding grants it immediately, and
    // A can now queue for B's path without closing a loop.
    expect(yielded.state.waits).toEqual([]);
    const requeued = manager.request(yielded.state, {
      sessionId: A,
      path: "src/ui",
    });
    expect(requeued.ok).toBe(true);
  });
});
