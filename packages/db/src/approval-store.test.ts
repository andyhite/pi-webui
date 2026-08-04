import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  answerApproval,
  declarePreGrant,
  destructionAsk,
  humanAuthor,
  INHERIT_APP_TOOLS,
  newApprovalId,
  newPreGrantId,
  raiseApproval,
  recordApprovalEffectFailure,
  sessionAuthor,
  toolCallAsk,
  type Approval,
  type SessionId,
  type WorkstreamId,
} from "@plotroom/core";
import { manualClock, type ManualClock } from "@plotroom/core/testing";
import { ApprovalStore } from "./approval-store.js";
import { openDatabase, type PlotroomDatabase } from "./client.js";
import { SessionStore } from "./session-store.js";
import { WorkstreamStore } from "./workstream-store.js";

let dir: string;
let state: PlotroomDatabase;
let clock: ManualClock;
let store: ApprovalStore;
let sessions: SessionStore;
let workstreamId: string;
let sessionId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-approvals-"));
  state = openDatabase({ stateDir: dir });
  clock = manualClock();
  store = new ApprovalStore(state, clock.now);
  sessions = new SessionStore(state, clock.now);
  workstreamId = new WorkstreamStore(state, clock.now).create({
    author: humanAuthor,
  }).id;
  sessionId = sessions.start({
    workstreamId,
    mode: "open",
    launch: {
      model: "fixture-model",
      effort: "medium",
      toolPermissions: INHERIT_APP_TOOLS,
    },
    initiatedBy: humanAuthor,
    runtime: { adapterId: "scripted", ref: "native-1" },
  }).session.id;
});

afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

function raise(callId: string | null = "call-1"): Approval {
  return store.raise(
    raiseApproval({
      id: newApprovalId(),
      sessionId: sessionId as SessionId,
      workstreamId: workstreamId as WorkstreamId,
      ask: destructionAsk({
        toolName: "object_delete",
        target: { kind: "object", id: "obj-1" },
      }),
      callId,
      at: clock.now(),
    }),
  );
}

describe("approvals", () => {
  it("round-trips the ask whole, so a row is answerable without the runtime", () => {
    const raised = raise();
    const read = store.get(raised.id);

    expect(read.ask).toEqual(raised.ask);
    expect(read.kind).toBe("destruction");
    expect(read.answer).toBeNull();
    expect(store.pending().map((approval) => approval.id)).toEqual([raised.id]);
  });

  it("finds the approval blocking one call, never just one of the session's", () => {
    const first = raise("call-1");
    const second = store.raise(
      raiseApproval({
        id: newApprovalId(),
        sessionId: sessionId as SessionId,
        workstreamId: workstreamId as WorkstreamId,
        ask: toolCallAsk({
          toolName: "shell",
          summary: "shell (no declared write extent)",
          intent: { kind: "unbounded", reason: "shell" },
          world: null,
        }),
        callId: "call-2",
        at: clock.now(),
      }),
    );

    expect(store.forCall(sessionId, "call-1")?.id).toBe(first.id);
    expect(store.forCall(sessionId, "call-2")?.id).toBe(second.id);
    expect(store.forCall(sessionId, "call-3")).toBeUndefined();
  });

  it("re-raising the same call answers with the approval already waiting", () => {
    const first = raise("call-1");
    const again = store.raise(
      raiseApproval({
        id: newApprovalId(),
        sessionId: sessionId as SessionId,
        workstreamId: workstreamId as WorkstreamId,
        ask: destructionAsk({
          toolName: "object_delete",
          target: { kind: "object", id: "obj-1" },
        }),
        callId: "call-1",
        at: clock.now() + 5,
      }),
    );

    expect(again.id).toBe(first.id);
    expect(store.pending()).toHaveLength(1);
  });

  it("persists the answer core produced, and drops the row from pending", () => {
    const raised = raise();
    const answered = answerApproval(raised, {
      decision: "deny",
      reason: "not that repository",
      by: humanAuthor,
      at: clock.now() + 10,
    });
    if (!answered.ok) throw new Error(answered.refusal.message);

    const saved = store.answer(answered.value);
    expect(saved.answer).toEqual({
      decision: "deny",
      reason: "not that repository",
      by: { kind: "human" },
      at: clock.now() + 10,
    });
    expect(store.pending()).toEqual([]);
  });

  it("keeps a failed effect at rest, where a restart cannot lose it", () => {
    const approved = answerApproval(raise(), {
      decision: "approve-once",
      by: humanAuthor,
      at: clock.now() + 10,
    });
    if (!approved.ok) throw new Error(approved.refusal.message);
    const saved = store.answer(approved.value);

    const recorded = recordApprovalEffectFailure(saved, {
      message: "the runtime would not stop the session",
      at: clock.now() + 20,
    });
    if (!recorded.ok) throw new Error(recorded.refusal.message);
    store.recordEffectFailure(recorded.value);

    // Answered, so it is not what is still being asked — and not history either.
    expect(store.pending()).toEqual([]);
    expect(store.effectFailures().map((row) => row.id)).toEqual([saved.id]);
    expect(store.get(saved.id).effectFailure).toEqual({
      message: "the runtime would not stop the session",
      at: clock.now() + 20,
    });

    // Reopened from the same directory: the whole reason this is a column.
    state.close();
    const reopened = openDatabase({ stateDir: dir });
    try {
      expect(
        new ApprovalStore(reopened, clock.now).get(saved.id).effectFailure
          ?.message,
      ).toBe("the runtime would not stop the session");
    } finally {
      reopened.close();
      state = openDatabase({ stateDir: dir });
    }
  });

  it("cannot represent a failed effect nobody authorized, or half of one", () => {
    const raised = raise();

    // Unanswered: core refuses it, and so does the schema — the second one is what
    // holds when a future call site reaches the table without the predicate.
    expect(() =>
      state.sqlite
        .prepare(
          "UPDATE approvals SET effect_failure_message = ?, effect_failed_at = ? WHERE id = ?",
        )
        .run("it broke", 500, raised.id),
    ).toThrow(/CHECK constraint failed/);

    // Half a failure: a time with nothing said, or a message at no time.
    expect(() =>
      state.sqlite
        .prepare("UPDATE approvals SET effect_failed_at = ? WHERE id = ?")
        .run(500, raised.id),
    ).toThrow(/CHECK constraint failed/);
  });
});

describe("pre-grants", () => {
  it("stores what binds a call: this session's grants and its workstream's", () => {
    const forSession = declarePreGrant({
      id: newPreGrantId(),
      scope: { kind: "session", sessionId: sessionId as SessionId },
      effect: "allow",
      kinds: ["integration-write"],
      toolPattern: "github_*",
      extents: ["none"],
      by: humanAuthor,
      at: clock.now(),
    });
    const forWorkstream = declarePreGrant({
      id: newPreGrantId(),
      scope: { kind: "workstream", workstreamId: workstreamId as WorkstreamId },
      effect: "deny",
      kinds: ["destruction"],
      toolPattern: "**",
      extents: ["none", "paths", "unbounded"],
      by: humanAuthor,
      at: clock.now(),
    });
    if (!forSession.ok || !forWorkstream.ok) {
      throw new Error("a human's pre-grant was refused");
    }

    store.declarePreGrant(forSession.value);
    store.declarePreGrant(forWorkstream.value);

    const binding = store.preGrantsFor(sessionId, workstreamId);
    expect(binding.map((grant) => grant.id).sort()).toEqual(
      [forSession.value.id, forWorkstream.value.id].sort(),
    );
    expect(
      binding.find((grant) => grant.scope.kind === "session")?.toolPattern,
    ).toBe("github_*");
  });

  it("withdraws rather than deletes, and a withdrawn grant binds nothing", () => {
    const declared = declarePreGrant({
      id: newPreGrantId(),
      scope: { kind: "session", sessionId: sessionId as SessionId },
      effect: "allow",
      kinds: ["tool-permission"],
      toolPattern: "**",
      extents: ["unbounded"],
      by: humanAuthor,
      at: clock.now(),
    });
    if (!declared.ok) throw new Error(declared.refusal.message);
    store.declarePreGrant(declared.value);

    const withdrawn = store.withdrawPreGrant(
      declared.value.id,
      clock.now() + 5,
    );
    expect(withdrawn.withdrawnAt).toBe(clock.now() + 5);
    expect(store.preGrantsFor(sessionId, workstreamId)).toEqual([]);
    // Retired, not gone: "revoked yesterday" and "never granted" differ.
    expect(store.preGrantList()).toHaveLength(1);
  });

  it("refuses a session's own pre-grant in core before it can be stored", () => {
    const attempted = declarePreGrant({
      id: newPreGrantId(),
      scope: { kind: "session", sessionId: sessionId as SessionId },
      effect: "allow",
      kinds: ["tool-permission"],
      toolPattern: "**",
      extents: ["unbounded"],
      by: sessionAuthor(sessionId as SessionId),
      at: clock.now(),
    });
    expect(attempted.ok).toBe(false);
  });
});
