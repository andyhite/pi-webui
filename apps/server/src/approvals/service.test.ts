import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  destructionAsk,
  humanAuthor,
  INHERIT_APP_TOOLS,
  sessionAuthor,
  type RequestOutcome,
  type RuntimeObservation,
  type RuntimeRequestId,
  type RuntimeSessionHandle,
  type SessionId,
} from "@plotroom/core";
import { manualClock, type ManualClock } from "@plotroom/core/testing";
import { openDatabase, type PlotroomDatabase } from "@plotroom/db";
import { createEventBus } from "../events/bus.js";
import { ApiError } from "../http/errors.js";
import { Logger } from "../logging/logger.js";
import { createStores, type ApiStores } from "../routes/api.js";
import { SessionHub } from "../sessions/hub.js";
import { ApprovalService } from "./service.js";

/**
 * An approved effect that fails (§6.6, #74).
 *
 * The failure this covers used to be silent three ways at once: the effect threw,
 * so the row was already answered and could never be answered again; `settle` never
 * ran; and the row had left `pending()`, so §7.1 showed nothing either. The
 * destruction the operator agreed to had not happened and no surface said so.
 *
 * The effect is the real one throughout — an approved `session_delete` whose
 * runtime stop rejects, which `destroySession` awaits before touching the record,
 * so nothing is deleted.
 *
 * **What is a fixture and what is production, stated rather than implied.** No
 * current raiser of an effect-bearing approval supplies a `requestId`: a session's
 * destruction arrives as an HTTP tool call the guard answers 202, and a claim wait
 * has no runtime request either. So `settle` is a no-op today and the reachable
 * damage is the 500, the row reading answered-and-done, and the silence — which is
 * what the no-request test below asserts, on exactly the shape the guard produces.
 * The `requestId` case beside it is the shape a **runtime-raised** destruction has,
 * which is what #81's permission gate introduces and why #74 blocks it; it is here
 * so the answer that reaches that call is pinned before the gate exists, not
 * because anything raises it that way now.
 */
let dir: string;
let state: PlotroomDatabase;
let clock: ManualClock;
let stores: ApiStores;
let approvals: ApprovalService;
let hub: SessionHub;
let workstreamId: string;
let sessionId: string;
let responded: { requestId: string; outcome: RequestOutcome }[];
let stopFails: boolean;

const STOP_FAILURE = "the runtime would not stop the session";
const CLAIM_REFUSAL =
  "this wait is already authorized and only waiting for the path to free; nothing to answer";

/** A live handle that records what the host told the blocked call. */
function handle(): RuntimeSessionHandle {
  return {
    ref: "native-1" as never,
    observations: (): AsyncIterable<RuntimeObservation> => ({
      // eslint-disable-next-line @typescript-eslint/require-await
      async *[Symbol.asyncIterator]() {
        // Nothing to observe: this fixture is about answering, not about running.
      },
    }),
    inject: () => Promise.reject(new Error("this fixture injects nothing")),
    respond: (requestId: RuntimeRequestId, outcome: RequestOutcome) => {
      responded.push({ requestId, outcome });
      return Promise.resolve();
    },
    stop: () => Promise.resolve(),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-approval-service-"));
  state = openDatabase({ stateDir: dir });
  clock = manualClock(1_000);
  const bus = createEventBus(clock.now);
  stores = createStores(state, bus, clock.now);
  hub = new SessionHub();
  responded = [];
  stopFails = true;

  approvals = new ApprovalService({
    stores,
    bus,
    logger: new Logger("error"),
    hub,
    // The failure #42 made reachable: `RunService.stopSession` awaits the runtime's
    // own stop, and a runtime can reject.
    stopSession: () =>
      stopFails
        ? Promise.reject(new Error(STOP_FAILURE))
        : Promise.resolve(undefined),
    // A claim manager that refuses the answer, which is the routine case: a wait
    // authorized while the operator was deciding has "nothing to answer".
    claims: {
      answerApproval: () => {
        throw new Error(CLAIM_REFUSAL);
      },
      waitExists: () => true,
      checkWrite: () => ({ allowed: true }),
    },
  });

  workstreamId = stores.workstreams.create({ author: humanAuthor }).id;
  sessionId = stores.sessions.start({
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

  hub.attach(sessionId, {
    handle: handle(),
    adapterId: "scripted",
    pump: Promise.resolve(),
  });
});

afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The session's ask to delete itself, **as the destruction guard raises it**: no
 * runtime request, because the gesture arrived over HTTP and was answered 202.
 */
function raiseSessionDelete() {
  return approvals.raise({
    sessionId,
    ask: destructionAsk({
      toolName: "session_delete",
      target: { kind: "session", id: sessionId },
    }),
  });
}

/**
 * The same ask with a blocked runtime call behind it — the shape a destruction
 * raised by the permission gate has (#81). Nothing raises it this way yet, which is
 * why it is a named fixture rather than the default one above.
 */
function raiseGatedSessionDelete() {
  return approvals.raise({
    sessionId,
    ask: destructionAsk({
      toolName: "session_delete",
      target: { kind: "session", id: sessionId },
    }),
    requestId: "req-1",
    callId: "call-1",
  });
}

describe("an approved effect that fails", () => {
  it("answers instead of throwing, and leaves nothing for the operator to guess", async () => {
    const raised = raiseSessionDelete();
    const answered = await approvals.answer({
      approvalId: raised.id,
      decision: "approve-once",
      actor: humanAuthor,
    });

    // The reachable bug: this call used to reject, so the operator got a 500 and
    // nothing anywhere recorded that their approved deletion had not happened.
    expect(answered.executed).toBe(false);
    expect(answered.effectFailure).toBe(STOP_FAILURE);
    // Nothing to settle: no runtime request was ever behind this gesture.
    expect(answered.settled).toBe(false);
    expect(responded).toEqual([]);
    expect(
      stores.sessions.get(sessionId).session.deletion.deletedAt,
    ).toBeNull();
  });

  it("tells a blocked runtime call the truth when there is one (#81's shape)", async () => {
    const raised = raiseGatedSessionDelete();
    const answered = await approvals.answer({
      approvalId: raised.id,
      decision: "approve-once",
      actor: humanAuthor,
    });

    expect(answered.settled).toBe(true);
    expect(answered.executed).toBe(false);
    expect(answered.effectFailure).toBe(STOP_FAILURE);

    // Denied, naming the failure: `allow` would tell the session its deletion
    // happened when the record is still there.
    expect(responded).toEqual([
      {
        requestId: "req-1",
        outcome: {
          kind: "deny",
          reason: `the operator approved this, but it could not be carried out: ${STOP_FAILURE}`,
        },
      },
    ]);

    // The destruction really did not happen, which is what makes the rest of this
    // a lie if it is not recorded.
    expect(
      stores.sessions.get(sessionId).session.deletion.deletedAt,
    ).toBeNull();
  });

  it("records the failure on the row, where a restart cannot lose it", async () => {
    const raised = raiseSessionDelete();
    clock.advance(5);
    await approvals.answer({
      approvalId: raised.id,
      decision: "approve-once",
      actor: humanAuthor,
    });

    const stored = approvals.get(raised.id);
    expect(stored.answer?.decision).toBe("approve-once");
    expect(stored.effectFailure).toEqual({ message: STOP_FAILURE, at: 1_005 });
    expect(stores.approvals.effectFailures().map((row) => row.id)).toEqual([
      raised.id,
    ]);
  });

  it("survives a listener that throws while being told the answer", async () => {
    // `EventBus.publish` calls its listeners inline and isolates none of them, and
    // one of them writes plugin grants and talks to a worker. A listener throwing
    // used to unwind out of `answer` before the effect or the settle — this bug
    // again, reached from the other side, and on the one kind of approval that does
    // have a blocked runtime call behind it.
    stopFails = false;
    stores.bus.subscribe((event) => {
      if (event.entity !== "approval" || event.verb !== "updated") return;
      throw new Error("a listener broke");
    });

    const raised = raiseGatedSessionDelete();
    const answered = await approvals.answer({
      approvalId: raised.id,
      decision: "approve-once",
      actor: humanAuthor,
    });

    expect(answered.effectFailure).toBe("a listener broke");
    expect(answered.settled).toBe(true);
    expect(responded[0]?.outcome).toEqual({
      kind: "deny",
      reason:
        "the operator approved this, but it could not be carried out: a listener broke",
    });
    // The effect never ran, and the row says so rather than reading answered-and-done.
    expect(
      stores.sessions.get(sessionId).session.deletion.deletedAt,
    ).toBeNull();
    expect(approvals.get(raised.id).effectFailure?.message).toBe(
      "a listener broke",
    );
  });

  it("keeps a runaway error message down to something a queue row can hold", async () => {
    stopFails = false;
    stores.bus.subscribe((event) => {
      if (event.entity !== "approval" || event.verb !== "updated") return;
      throw new Error(`sqlite said:\n${"x".repeat(4000)}`);
    });

    const raised = raiseSessionDelete();
    const answered = await approvals.answer({
      approvalId: raised.id,
      decision: "approve-once",
      actor: humanAuthor,
    });

    // One line, capped, and it says it was capped — this string becomes the §7.1
    // sentence and travels to an outbound route (§7.3).
    const message = answered.effectFailure ?? "";
    expect(message.length).toBeLessThan(400);
    expect(message).not.toContain("\n");
    expect(message).toContain("truncated");
    expect(message.startsWith("sqlite said: xxx")).toBe(true);
  });

  it("reports it as §7.1's own row, and never as one still being asked", async () => {
    const raised = raiseSessionDelete();
    await approvals.answer({
      approvalId: raised.id,
      decision: "approve-once",
      actor: humanAuthor,
    });

    const rows = approvals.effectFailureAttention();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.approval.id).toBe(raised.id);
    expect(rows[0]?.attention.effectFailure).toBe(STOP_FAILURE);
    expect(rows[0]?.attention.sentence).toContain("could not be carried out");
    // Nothing to answer here; the decision was made and the effect is what broke.
    expect(rows[0]?.attention.answers).toEqual([]);

    // And not in the asking list, which the health feed reads as "nobody has
    // answered this yet" — an answered row in there is an alert saying something
    // false, timed from the raise, that never clears (§7.2's `unanswered`).
    expect(approvals.attention()).toEqual([]);
  });

  it("does not hand the answer back: the decision was a human's and it stands", async () => {
    const raised = raiseSessionDelete();
    await approvals.answer({
      approvalId: raised.id,
      decision: "approve-once",
      actor: humanAuthor,
    });

    // Retrying it is refused, not replayed. A second `approve-once` would re-run an
    // effect that may have partly applied (#76), and erase what the operator
    // decided on the way.
    await expect(
      approvals.answer({
        approvalId: raised.id,
        decision: "approve-once",
        actor: humanAuthor,
      }),
    ).rejects.toThrowError(ApiError);
  });

  it("stops authorizing the gesture, so a repeat asks the operator again", async () => {
    const raised = raiseSessionDelete();
    await approvals.answer({
      approvalId: raised.id,
      decision: "approve-once",
      actor: humanAuthor,
    });

    // One answer, one attempt. The session repeating its delete used to find this
    // row still saying "approved" and execute with nobody asked a second time —
    // re-running a destruction that may already have partly applied (#76).
    const routing = approvals.decideDestruction({
      toolName: "session_delete",
      targetId: sessionId,
      actor: sessionAuthor(sessionId as SessionId),
      sessionId,
      workstreamId,
    });
    expect(routing.kind).toBe("destruction");
    if (routing.kind !== "destruction") return;
    expect(routing.verdict.kind).toBe("denied");
    if (routing.verdict.kind !== "denied") return;
    expect(routing.verdict.reason).toContain(STOP_FAILURE);
  });

  it("records nothing when settling a claim wait fails: that state resolves itself", async () => {
    const raised = approvals.raise({
      sessionId,
      ask: {
        kind: "claim",
        trigger: "outside-policy",
        tool: null,
        summary: `${sessionId} is waiting for a write claim no policy covers`,
        writeExtent: "paths",
        paths: ["src/app.ts"],
        world: null,
        target: { kind: "claim-wait", id: "wait-1" },
      },
      requestId: "req-claim",
      callId: "call-claim",
    });

    const answered = await approvals.answer({
      approvalId: raised.id,
      decision: "approve-once",
      actor: humanAuthor,
    });

    // The wait refused the answer — most often because it was authorized while the
    // operator was deciding, or because its granting claim went and it will re-raise.
    // Neither is an unfinished gesture, so neither becomes a durable failure.
    expect(answered.effectFailure).toBeNull();
    expect(approvals.get(raised.id).effectFailure).toBeNull();
    expect(approvals.effectFailureAttention()).toEqual([]);
  });

  it("leaves an ordinary approval alone: nothing recorded, and the effect happens", async () => {
    stopFails = false;
    const raised = raiseGatedSessionDelete();
    const answered = await approvals.answer({
      approvalId: raised.id,
      decision: "approve-once",
      actor: humanAuthor,
    });

    expect(answered.executed).toBe(true);
    expect(answered.effectFailure).toBeNull();
    expect(responded).toEqual([
      { requestId: "req-1", outcome: { kind: "allow" } },
    ]);
    expect(approvals.get(raised.id).effectFailure).toBeNull();
    expect(approvals.attention()).toEqual([]);
    expect(approvals.effectFailureAttention()).toEqual([]);
    expect(
      stores.sessions.get(sessionId).session.deletion.deletedAt,
    ).not.toBeNull();
  });
});
