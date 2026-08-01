import { describe, expect, it } from "vitest";

import { humanAuthor, sessionAuthor } from "../author.js";
import { newSessionId } from "../ids.js";
import {
  checkDeletion,
  isDeleted,
  markDeleted,
  markRestored,
  NOT_DELETED,
} from "./deletion.js";
import { endStateFacts } from "./end-states.js";
import { planFork } from "./fork.js";
import {
  ADAPTER_REPORTABLE_END_KINDS,
  checkPermissionEnforcement,
  checkToolPermissions,
  classifyEnd,
  isAdapterReportable,
  type RuntimeCapabilities,
  type SessionEndReason,
} from "./runtime.js";
import { endSession, isRunning, startSession } from "./session.js";
import { makeSession, makeTranscript, makeTurn } from "./testing.js";
import { applyRelease, planRelease } from "./transcript.js";

const CAPABLE: RuntimeCapabilities = {
  fork: "turn-boundary",
  injection: "between-turns",
  reportsCost: true,
  reportsContextWindow: false,
  enforcesPermissions: true,
};

describe("SessionEndReason reconciled with the end-state taxonomy", () => {
  it("never lets an adapter claim out-of-budget", () => {
    const reasons: readonly SessionEndReason[] = [
      { kind: "completed" },
      { kind: "ended-by-user" },
      { kind: "stopped", by: "user" },
      { kind: "failed", message: "boom" },
      { kind: "interrupted", message: "restart" },
    ];

    expect(reasons.map((reason) => reason.kind).sort()).toEqual(
      [...ADAPTER_REPORTABLE_END_KINDS].sort(),
    );
    for (const reason of reasons)
      expect(isAdapterReportable(reason)).toBe(true);
    expect(isAdapterReportable({ kind: "out-of-budget", scope: "run" })).toBe(
      false,
    );
  });

  it("records a PlotRoom-initiated budget stop as out-of-budget, whatever the runtime said", () => {
    const end = classifyEnd({ kind: "stopped", by: "user" }, 900, {
      budgetStop: { scope: "workstream" },
    });

    expect(end).toEqual({
      kind: "out-of-budget",
      scope: "workstream",
      at: 900,
    });
    expect(endStateFacts(end).safeToRetryBlindly).toBe(false);
  });

  it("records a restart with the session in flight as interrupted", () => {
    const end = classifyEnd({ kind: "failed", message: "pipe closed" }, 900, {
      interrupted: { message: "the server restarted" },
    });

    expect(end.kind).toBe("interrupted");
    expect(endStateFacts(end).failed).toBe(false);
  });

  it("passes every other reason through unchanged", () => {
    expect(classifyEnd({ kind: "completed" }, 10)).toEqual({
      kind: "completed",
      at: 10,
    });
    expect(classifyEnd({ kind: "stopped", by: "session" }, 10)).toEqual({
      kind: "stopped",
      by: "session",
      at: 10,
    });
    expect(classifyEnd({ kind: "interrupted", message: "gone" }, 10)).toEqual({
      kind: "interrupted",
      message: "gone",
      at: 10,
    });
  });
});

describe("per-session launch choices (§3.6)", () => {
  it("lets a session be launched narrower than the app", () => {
    expect(
      checkToolPermissions(
        { allowedTools: ["read", "write", "bash"] },
        { allowedTools: ["read"] },
      ),
    ).toEqual({ allowed: true });
  });

  it("refuses one launched wider", () => {
    const check = checkToolPermissions(
      { allowedTools: ["read"] },
      { allowedTools: ["read", "bash"] },
    );

    expect(check.allowed).toBe(false);
    expect(check.allowed === false && check.refusal.tools).toEqual(["bash"]);
  });

  it("treats an inherited list as narrower, never wider", () => {
    expect(
      checkToolPermissions({ allowedTools: ["read"] }, { allowedTools: null }),
    ).toEqual({ allowed: true });
    expect(
      checkToolPermissions({ allowedTools: null }, { allowedTools: ["bash"] }),
    ).toEqual({ allowed: true });
  });
});

describe("C6: permissions are enforced, not advised", () => {
  it("allows a runtime that decides tool calls with the host", () => {
    expect(checkPermissionEnforcement(CAPABLE)).toEqual({ allowed: true });
  });

  it("refuses one that cannot", () => {
    const check = checkPermissionEnforcement({
      ...CAPABLE,
      enforcesPermissions: false,
    });

    expect(check.allowed).toBe(false);
    expect(check.allowed === false && check.refusal.reason).toBe(
      "permissions_advisory_only",
    );
  });
});

describe("fork emulation (§6.3)", () => {
  const transcript = makeTranscript({
    turns: [
      makeTurn({ ordinal: 1, entries: [{ kind: "output", text: "first" }] }),
      makeTurn({ ordinal: 2, entries: [{ kind: "output", text: "second" }] }),
      makeTurn({ ordinal: 3, entries: [{ kind: "output", text: "third" }] }),
    ],
  });

  it("forks natively when the runtime can reach the point", () => {
    expect(planFork(CAPABLE, transcript, { turn: 2 })).toEqual({
      mode: "native",
      point: { turn: 2 },
    });
  });

  it("seeds from the transcript prefix when it cannot", () => {
    const plan = planFork({ ...CAPABLE, fork: "none" }, transcript, {
      turn: 2,
    });

    expect(plan.mode).toBe("seeded");
    if (plan.mode !== "seeded") return;
    expect(plan.reason).toBe("no-native-fork");
    expect(plan.throughTurn).toBe(2);
    expect(plan.seed).toContain("first");
    expect(plan.seed).toContain("second");
    expect(plan.seed).not.toContain("third");
    expect(plan.complete).toBe(true);
  });

  it("seeds when the point is not a turn boundary the runtime knows", () => {
    const plan = planFork(CAPABLE, transcript, { turn: 9 });

    expect(plan.mode).toBe("seeded");
    if (plan.mode !== "seeded") return;
    expect(plan.reason).toBe("not-a-turn-boundary");
  });

  it("reports a seed it could not complete rather than truncating silently", () => {
    const withTool = makeTranscript({
      turns: [
        makeTurn({
          ordinal: 1,
          entries: [
            {
              kind: "tool-result",
              callId: "call-1",
              toolName: "bash",
              output: "x".repeat(500),
              isError: false,
              released: null,
            },
          ],
        }),
        makeTurn({ ordinal: 2 }),
      ],
    });
    const released = applyRelease(
      withTool,
      planRelease(withTool, 0),
      50,
      () => "sha256:x",
    );

    const plan = planFork({ ...CAPABLE, fork: "none" }, released, { turn: 1 });

    expect(plan.mode).toBe("seeded");
    if (plan.mode !== "seeded") return;
    expect(plan.complete).toBe(false);
    expect(plan.unavailable).toEqual(["call-1"]);
  });
});

describe("the session record (§3.6, principle 10)", () => {
  it("is live until it ends, and keeps the first outcome", () => {
    const session = makeSession();
    expect(isRunning(session)).toBe(true);

    const ended = endSession(session, {
      kind: "out-of-budget",
      scope: "global",
      at: 10,
    });
    const again = endSession(ended, {
      kind: "failed",
      message: "late",
      at: 20,
    });

    expect(isRunning(ended)).toBe(false);
    expect(again.end).toEqual({
      kind: "out-of-budget",
      scope: "global",
      at: 10,
    });
  });

  it("starts with a clean accounting record", () => {
    const session = startSession(
      {
        id: newSessionId(),
        workstreamId: makeSession().workstreamId,
        commandId: null,
        mode: "producing",
        launch: makeSession().launch,
        initiatedBy: humanAuthor,
        runtime: { adapterId: "pi-coding-agent", ref: "ref-1" },
      },
      4_000,
    );

    expect(session.accounting).toMatchObject({ turns: 0, startedAt: 4_000 });
    expect(session.end).toBeNull();
    expect(session.deletion).toEqual(NOT_DELETED);
  });

  it("soft-deletes and restores authored state", () => {
    const deleted = markDeleted(NOT_DELETED, 100, humanAuthor);
    expect(isDeleted({ deletion: deleted })).toBe(true);
    expect(deleted.deletedBy).toEqual(humanAuthor);

    const restored = markRestored(deleted, 200);
    expect(isDeleted({ deletion: restored })).toBe(false);
    expect(restored.restoredAt).toBe(200);
  });

  it("sends an agent's deletion through approval (principle 8, §6.6)", () => {
    const agent = sessionAuthor(newSessionId());

    expect(checkDeletion(humanAuthor)).toEqual({ allowed: true });
    expect(checkDeletion(agent).allowed).toBe(false);
    expect(checkDeletion(agent, { preApproved: true })).toEqual({
      allowed: true,
    });
  });

  it("refuses injection into a deleted session", () => {
    const session = makeSession();
    const deleted = {
      ...session,
      deletion: markDeleted(session.deletion, 100, humanAuthor),
    };

    expect(isRunning(deleted)).toBe(false);
  });
});
