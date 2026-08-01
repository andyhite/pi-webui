import { describe, expect, it } from "vitest";

import { newSessionId, newWorkstreamId } from "../ids.js";
import { resolveStop, type StopCandidate } from "./stop.js";

const alpha = newWorkstreamId();
const beta = newWorkstreamId();

const one = newSessionId();
const two = newSessionId();
const three = newSessionId();
const ended = newSessionId();

const fleet: readonly StopCandidate[] = [
  { sessionId: one, workstreamId: alpha, running: true },
  { sessionId: two, workstreamId: alpha, running: true },
  { sessionId: three, workstreamId: beta, running: true },
  { sessionId: ended, workstreamId: beta, running: false },
];

describe("stop at three scopes, with counts (§6.7)", () => {
  it("names how many one session's stop affects", () => {
    const plan = resolveStop(fleet, { kind: "session", sessionId: one });

    expect(plan.count).toBe(1);
    expect(plan.sessionIds).toEqual([one]);
    expect(plan.enabled).toBe(true);
    expect(plan.requiresConfirmation).toBe(false);
  });

  it("counts every running session in a workstream, and no ended one", () => {
    const plan = resolveStop(fleet, {
      kind: "workstream",
      workstreamId: alpha,
    });

    expect(plan.count).toBe(2);
    expect(plan.description).toBe("stop 2 sessions in this workstream");

    const other = resolveStop(fleet, {
      kind: "workstream",
      workstreamId: beta,
    });
    expect(other.sessionIds).toEqual([three]);
  });

  it("confirms at the widest scope only", () => {
    const everything = resolveStop(fleet, { kind: "everything" });

    expect(everything.count).toBe(3);
    expect(everything.workstreamIds).toEqual([alpha, beta]);
    expect(everything.requiresConfirmation).toBe(true);
    expect(everything.description).toBe("stop 3 sessions across 2 workstreams");

    expect(
      resolveStop(fleet, { kind: "workstream", workstreamId: alpha })
        .requiresConfirmation,
    ).toBe(false);
  });

  it("is disabled when nothing is running, at every scope", () => {
    const quiet: readonly StopCandidate[] = [
      { sessionId: ended, workstreamId: beta, running: false },
    ];

    for (const scope of [
      { kind: "session", sessionId: ended } as const,
      { kind: "workstream", workstreamId: beta } as const,
      { kind: "everything" } as const,
    ]) {
      const plan = resolveStop(quiet, scope);
      expect(plan.enabled).toBe(false);
      expect(plan.count).toBe(0);
      expect(plan.description).toBe("nothing is running");
    }
  });

  it("says 'session' in the singular", () => {
    const plan = resolveStop(fleet, { kind: "workstream", workstreamId: beta });
    expect(plan.description).toBe("stop 1 session in this workstream");
  });
});
