import { describe, expect, it } from "vitest";

import { humanAuthor, sessionAuthor } from "../author.js";
import { waitForEdges } from "./deadlock.js";
import { createClaimManager, type ClaimManager } from "./manager.js";
import {
  rootClaimOf,
  type Claim,
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

function must<T>(outcome: ClaimOutcome<T>): { state: ClaimState; result: T } {
  if (!outcome.ok) throw new Error(`refused: ${outcome.refusal.message}`);
  return { state: outcome.state, result: outcome.result };
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
