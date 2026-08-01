import { describe, expect, it } from "vitest";

import { humanAuthor, sessionAuthor } from "../author.js";
import type { SessionId } from "../ids.js";
import { createClaimManager, type ClaimManager } from "./manager.js";
import {
  authorityFor,
  claimById,
  grantChainOf,
  isHeldBy,
  rootClaimOf,
  violatesGrantExtent,
  violatesSingleWriter,
  type Claim,
  type ClaimState,
} from "./model.js";
import { claimPath, isWithin } from "./paths.js";
import { countingClaimIds, session, testClock, ws } from "./testing.js";

/**
 * The invariants, asserted over sequences rather than over cases.
 *
 * §3.4's guarantee ("one writer per path, always") and the reason it is
 * consistent with principle 1 ("a claim can only be granted from capability the
 * granter already holds") are properties of every reachable state, not of a
 * handful of examples. This suite drives the manager through pseudo-random but
 * fully deterministic operation sequences and re-checks both after every step.
 */

const SESSIONS: readonly SessionId[] = [
  session("sess_a"),
  session("sess_b"),
  session("sess_c"),
];

const PATHS = [
  ".",
  "src",
  "src/api",
  "src/api/route.ts",
  "src/ui",
  "src/ui/app.tsx",
  "docs",
  "docs/readme.md",
  "migrations",
  "not/created/yet.ts",
] as const;

/** A tiny deterministic PRNG (mulberry32), so a failing seed is reproducible. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Run {
  readonly state: ClaimState;
  readonly manager: ClaimManager;
  readonly steps: readonly string[];
}

function drive(seed: number, steps: number): Run {
  const next = random(seed);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(next() * items.length)] as T;

  const clock = testClock();
  const manager = createClaimManager({
    clock,
    ids: countingClaimIds(),
    defaultLeaseSeconds: 300,
  });
  let state = manager.open(ws()).state;
  const log: string[] = [];

  const record = (label: string) => log.push(label);

  for (let step = 0; step < steps; step += 1) {
    clock.tick(Math.floor(next() * 200));
    const sessionId = pick(SESSIONS);
    const path = pick(PATHS);
    const roll = next();

    if (roll < 0.35) {
      const outcome = manager.request(state, { sessionId, path });
      record(`request ${sessionId} ${path}`);
      if (outcome.ok) state = outcome.state;
    } else if (roll < 0.45) {
      const outcome = manager.grant(state, {
        path,
        to: sessionId,
        by: humanAuthor,
      });
      record(`grant ${sessionId} ${path}`);
      if (outcome.ok) state = outcome.state;
    } else if (roll < 0.55) {
      const claim = pick(state.claims);
      const outcome = manager.declarePolicy(state, {
        claimId: claim.id,
        subtree: claim.path.display,
        effect: next() < 0.5 ? "allow" : "deny",
        by: humanAuthor,
      });
      record(`policy ${claim.path.display}`);
      if (outcome.ok) state = outcome.state;
    } else if (roll < 0.7) {
      const claim = pick(state.claims);
      const outcome = manager.yieldClaim(state, {
        claimId: claim.id,
        by: humanAuthor,
      });
      record(`yield ${claim.path.display}`);
      if (outcome.ok) state = outcome.state;
    } else if (roll < 0.8) {
      const claim = pick(state.claims);
      const outcome = manager.forceRelease(state, {
        claimId: claim.id,
        by: humanAuthor,
        cascade: next() < 0.5,
      });
      record(`force-release ${claim.path.display}`);
      if (outcome.ok) state = outcome.state;
    } else if (roll < 0.9) {
      const outcome = manager.endSession(state, sessionId);
      record(`end ${sessionId}`);
      if (outcome.ok) state = outcome.state;
    } else {
      const outcome = manager.expire(state);
      record("expire");
      if (outcome.ok) state = outcome.state;
    }

    assertInvariants(state, manager, log);
  }

  return { state, manager, steps: log };
}

function assertInvariants(
  state: ClaimState,
  manager: ClaimManager,
  log: readonly string[],
): void {
  const trail = log.join(" | ");

  // Principle 1's reason this is consistent: no claim exceeds its granter's own.
  expect(violatesGrantExtent(state), trail).toEqual([]);

  // Principle 4: one writer per path, always. The structural half (no ambiguous
  // pair) and the behavioural half (`checkWrite` names at most one writer, below)
  // are both asserted, because either alone can be satisfied vacuously.
  expect(violatesSingleWriter(state), trail).toEqual([]);

  // The root claim is never released, so the grant tree always terminates at the
  // human grant everything subdivides.
  const root = rootClaimOf(state);
  expect(root, trail).toBeDefined();
  for (const claim of state.claims) {
    const chain = grantChainOf(state, claim.id);
    expect(chain.at(-1)?.id, trail).toBe(root?.id);
  }

  // Writability is single-valued: for any path, at most one session is allowed to
  // write it, and it is the holder of the deepest covering claim.
  for (const path of PATHS) {
    const allowed = SESSIONS.filter(
      (sessionId) =>
        manager.checkWrite(state, sessionAuthor(sessionId), path).allowed,
    );
    expect(allowed.length, `${trail} :: ${path}`).toBeLessThanOrEqual(1);
    const authority = authorityFor(state, claimPath(path));
    if (allowed.length === 1) {
      expect(
        isHeldBy(authority as Claim, sessionAuthor(allowed[0] as SessionId)),
        trail,
      ).toBe(true);
    }
  }

  // Every wait points at live rows: a waitlist referencing a released claim would
  // be a stall nobody can explain.
  for (const wait of state.waits) {
    for (const claimId of wait.blockedByClaimIds) {
      expect(claimById(state, claimId), trail).toBeDefined();
    }
    if (wait.grantorClaimId !== null) {
      const grantor = claimById(state, wait.grantorClaimId);
      expect(grantor, trail).toBeDefined();
      expect(isWithin(wait.path, (grantor as Claim).path), trail).toBe(true);
    }
    // A wait that is available and authorized should have been promoted already.
    const stillAvailable =
      wait.blockedByClaimIds.length === 0 && wait.authorizedAt !== null;
    expect(stillAvailable, `${trail} :: unpromoted wait ${wait.id}`).toBe(
      false,
    );
  }

  // Policies never outlive their declaring claim, and never exceed its extent.
  for (const policy of state.policies) {
    const declaring = claimById(state, policy.declaredByClaimId);
    expect(declaring, trail).toBeDefined();
    expect(isWithin(policy.subtree, (declaring as Claim).path), trail).toBe(
      true,
    );
  }
}

describe("claim invariants over random operation sequences", () => {
  for (const seed of [1, 7, 42, 1337, 20_250_801]) {
    it(`holds for seed ${seed}`, () => {
      const run = drive(seed, 120);
      expect(run.steps.length).toBe(120);
    });
  }

  it("is deterministic: the same seed produces the same state", () => {
    const first = drive(99, 60);
    const second = drive(99, 60);
    expect(first.state).toEqual(second.state);
    expect(first.steps).toEqual(second.steps);
  });
});

describe("no grant can exceed the granter's extent, by construction", () => {
  it("refuses a sub-claim outside the authority, resolving to the wider holder instead", () => {
    const clock = testClock();
    const manager = createClaimManager({ clock, ids: countingClaimIds() });
    const opened = manager.open(ws());
    const held = manager.grant(opened.state, {
      path: "src/api",
      to: SESSIONS[0] as SessionId,
      by: humanAuthor,
    });
    if (!held.ok) throw new Error(held.refusal.message);

    // The holder of `src/api` allows everything it can. It still cannot grant
    // `src/ui`, because it does not hold it: the request resolves to the root
    // holder, whose grant it would be.
    const declared = manager.declarePolicy(held.state, {
      claimId: (held.result as { claim: Claim }).claim.id,
      subtree: "src/api",
      effect: "allow",
      by: sessionAuthor(SESSIONS[0] as SessionId),
    });
    if (!declared.ok) throw new Error(declared.refusal.message);

    const outside = manager.request(declared.state, {
      sessionId: SESSIONS[1] as SessionId,
      path: "src/ui",
    });
    expect(outside.ok).toBe(true);
    if (!outside.ok) return;
    expect(outside.result.kind).toBe("approval-required");
    if (outside.result.kind !== "approval-required") return;
    expect(outside.result.grantor).toEqual(humanAuthor);
  });
});
