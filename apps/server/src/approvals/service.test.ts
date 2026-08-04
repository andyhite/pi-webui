import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  destructionAsk,
  humanAuthor,
  INHERIT_APP_TOOLS,
  type RequestOutcome,
  type RuntimeObservation,
  type RuntimeRequestId,
  type RuntimeSessionHandle,
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
 * The failure this covers is specific and it used to be silent in three places at
 * once: the effect threw, so the row was already answered and could never be
 * answered again, `settle` never ran and the blocked call waited for ever, and the
 * row had left `pending()` so §7.1 showed nothing either. Under the embedded
 * sidecar that unsettled call is an in-process await inside a session-host process
 * PlotRoom owns and pays for, which is why it wedges a process rather than merely
 * losing a call.
 *
 * The path exercised here is the real one: an approved `session_delete` whose
 * runtime stop rejects (`destroySession` awaits it before touching the record), so
 * the destruction genuinely does not happen.
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

/** The session's own ask to delete itself, blocking a runtime call. */
function raiseSessionDelete() {
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
  it("settles the blocked call rather than leaving a session-host process wedged", async () => {
    const raised = raiseSessionDelete();
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

  it("keeps asking in §7.1, because the operator's own gesture is unfinished", async () => {
    const raised = raiseSessionDelete();
    await approvals.answer({
      approvalId: raised.id,
      decision: "approve-once",
      actor: humanAuthor,
    });

    const rows = approvals.attention();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.approval.id).toBe(raised.id);
    expect(rows[0]?.attention.effectFailure).toBe(STOP_FAILURE);
    expect(rows[0]?.attention.sentence).toContain("could not be carried out");
    // Nothing to answer here; the decision was made and the effect is what broke.
    expect(rows[0]?.attention.answers).toEqual([]);
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

  it("leaves an ordinary approval alone: nothing recorded, and the effect happens", async () => {
    stopFails = false;
    const raised = raiseSessionDelete();
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
    expect(
      stores.sessions.get(sessionId).session.deletion.deletedAt,
    ).not.toBeNull();
  });
});
