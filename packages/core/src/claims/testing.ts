import type { SessionId, WorkstreamId } from "../ids.js";
import type { ClaimId, ClaimPolicyId, ClaimWaitId } from "./ids.js";
import type { ClaimIdFactory } from "./manager.js";

/**
 * Deterministic fixtures for the claim tests.
 *
 * The manager is pure, so the only two sources of nondeterminism are the clock
 * and the id factory; both are injected, and these make them countable — a test
 * asserting "the newest claim is refused" needs to know which one is newest.
 */

export function countingClaimIds(): ClaimIdFactory {
  let claims = 0;
  let waits = 0;
  let policies = 0;
  return {
    claim: () => `claim_${String(++claims).padStart(3, "0")}` as ClaimId,
    wait: () => `claimwait_${String(++waits).padStart(3, "0")}` as ClaimWaitId,
    policy: () =>
      `claimpol_${String(++policies).padStart(3, "0")}` as ClaimPolicyId,
  };
}

/** A clock the test moves by hand: `tick(60)` is a minute of inactivity. */
export interface TestClock {
  (): number;
  set(seconds: number): void;
  tick(seconds: number): number;
}

export function testClock(start = 1_700_000_000): TestClock {
  let current = start;
  const clock = (() => current) as TestClock;
  clock.set = (seconds: number) => {
    current = seconds;
  };
  clock.tick = (seconds: number) => {
    current += seconds;
    return current;
  };
  return clock;
}

export const ws = (name = "ws-1"): WorkstreamId => name as WorkstreamId;
export const session = (name: string): SessionId => name as SessionId;
