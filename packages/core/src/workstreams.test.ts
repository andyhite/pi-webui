import { describe, expect, it } from "vitest";
import { humanAuthor, sessionAuthor } from "./author.js";
import type { SessionId, WorkstreamId } from "./ids.js";
import {
  checkLifecycleAuthoring,
  checkScope,
  rollupAttention,
  suggestDone,
  EMPTY_ATTENTION,
  type WorkstreamActivity,
} from "./workstreams.js";

const WS_A = "ws_a" as WorkstreamId;
const WS_B = "ws_b" as WorkstreamId;

describe("lifecycle is authored by the human (§3.3)", () => {
  it("allows a human", () => {
    expect(checkLifecycleAuthoring(humanAuthor).allowed).toBe(true);
  });

  it("refuses a session, pointing at propose-and-accept", () => {
    const check = checkLifecycleAuthoring(sessionAuthor("sess_1" as SessionId));

    expect(check.allowed).toBe(false);
    if (!check.allowed) {
      expect(check.refusal.reason).toBe("session_sets_lifecycle");
      expect(check.refusal.message).toMatch(/propose/);
    }
  });
});

describe("the scope rule (§3.3)", () => {
  it("lets a world object cross workstream boundaries", () => {
    expect(
      checkScope({ kind: "object", scope: "world", workstreamId: null }, WS_B)
        .legal,
    ).toBe(true);
  });

  it("keeps a local object inside its workstream", () => {
    const check = checkScope(
      { kind: "object", scope: "local", workstreamId: WS_A },
      WS_B,
    );

    expect(check.legal).toBe(false);
    if (!check.legal) {
      expect(check.refusal.reason).toBe("local_object");
      expect(check.refusal.message).toMatch(/promote/);
    }
  });

  it("allows a local object within its own workstream", () => {
    expect(
      checkScope({ kind: "object", scope: "local", workstreamId: WS_A }, WS_A)
        .legal,
    ).toBe(true);
  });

  it("never lets a command cross", () => {
    const check = checkScope({ kind: "command", workstreamId: WS_A }, WS_B);

    expect(check.legal).toBe(false);
    if (!check.legal) expect(check.refusal.reason).toBe("command_confined");
  });

  it("never lets a session cross", () => {
    const check = checkScope({ kind: "session", workstreamId: WS_A }, WS_B);

    expect(check.legal).toBe(false);
    if (!check.legal) expect(check.refusal.reason).toBe("session_confined");
  });

  it("does not constrain an entity that belongs to no workstream", () => {
    expect(
      checkScope({ kind: "object", scope: "world", workstreamId: null }, null)
        .legal,
    ).toBe(true);
  });
});

describe("done is suggested, never applied (§3.3)", () => {
  const activity = (
    overrides: Partial<WorkstreamActivity> = {},
  ): WorkstreamActivity => ({
    producingCommands: 0,
    completedProducingCommands: 0,
    totalSessions: 0,
    runningSessions: 0,
    driftedInputs: 0,
    ...overrides,
  });

  it("suggests when every producing command has completed", () => {
    expect(
      suggestDone(
        "active",
        activity({ producingCommands: 2, completedProducingCommands: 2 }),
      ),
    ).toBe(true);
  });

  it("stays quiet while a producing command is outstanding", () => {
    expect(
      suggestDone(
        "active",
        activity({ producingCommands: 2, completedProducingCommands: 1 }),
      ),
    ).toBe(false);
  });

  it("suggests for open-only work when every session ended and nothing drifted", () => {
    expect(
      suggestDone("active", activity({ totalSessions: 3, runningSessions: 0 })),
    ).toBe(true);
  });

  it("stays quiet while a session runs or an input is drifted", () => {
    expect(
      suggestDone("active", activity({ totalSessions: 3, runningSessions: 1 })),
    ).toBe(false);
    expect(
      suggestDone("active", activity({ totalSessions: 3, driftedInputs: 1 })),
    ).toBe(false);
  });

  it("has nothing to say about an empty scratch workstream", () => {
    expect(suggestDone("active", activity())).toBe(false);
  });

  it("never suggests for a workstream that is already done or abandoned", () => {
    const finished = activity({
      producingCommands: 1,
      completedProducingCommands: 1,
    });

    expect(suggestDone("done", finished)).toBe(false);
    expect(suggestDone("abandoned", finished)).toBe(false);
  });
});

describe("attention rolls up to one status (§3.3, §7)", () => {
  it("is quiet when nothing is happening", () => {
    expect(rollupAttention(EMPTY_ATTENTION).status).toBe("quiet");
  });

  it("ranks decisions above everything", () => {
    expect(
      rollupAttention({
        ...EMPTY_ATTENTION,
        questions: 1,
        healthAlerts: 2,
        drift: 3,
        runningSessions: 4,
      }).status,
    ).toBe("needs_decision");
    expect(rollupAttention({ ...EMPTY_ATTENTION, approvals: 1 }).status).toBe(
      "needs_decision",
    );
  });

  it("ranks health above drift, drift above working", () => {
    expect(
      rollupAttention({
        ...EMPTY_ATTENTION,
        healthAlerts: 1,
        drift: 1,
        runningSessions: 1,
      }).status,
    ).toBe("unhealthy");
    expect(
      rollupAttention({ ...EMPTY_ATTENTION, drift: 1, runningSessions: 1 })
        .status,
    ).toBe("drifted");
    expect(
      rollupAttention({ ...EMPTY_ATTENTION, runningSessions: 1 }).status,
    ).toBe("working");
  });

  it("never lets completions dominate the card", () => {
    const rollup = rollupAttention({ ...EMPTY_ATTENTION, completions: 5 });

    expect(rollup.status).toBe("quiet");
    expect(rollup.completions).toBe(5);
  });
});
