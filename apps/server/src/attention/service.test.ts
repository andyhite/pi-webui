import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimPath,
  destructionAsk,
  humanAuthor,
  INHERIT_APP_TOOLS,
  sessionAuthor,
  type SessionId,
} from "@plotroom/core";
import { manualClock, type ManualClock } from "@plotroom/core/testing";
import { openDatabase, type PlotroomDatabase } from "@plotroom/db";
import { ApprovalService } from "../approvals/service.js";
import { ClaimService } from "../claims/service.js";
import { createEventBus } from "../events/bus.js";
import { Logger } from "../logging/logger.js";
import { createStores, type ApiStores } from "../routes/api.js";
import { SessionHub } from "../sessions/hub.js";
import { AttentionService } from "./service.js";

/**
 * The health derivation, over real records (§7.2).
 *
 * `@plotroom/core`'s `health.test.ts` proves the rules; what is proved here is
 * the **join** — that the observations PlotRoom actually stores produce those
 * readings. The clock is injected and the thresholds are configured, because a
 * test that waited ten minutes for an idle alert would be a test nobody runs.
 */
let dir: string;
let state: PlotroomDatabase;
let clock: ManualClock;
let stores: ApiStores;
let attention: AttentionService;
let approvals: ApprovalService;
let workstreamId: string;

const THRESHOLDS = {
  idleSeconds: 60,
  spinningSeconds: 60,
  spinningCostMicros: 10_000,
  unansweredSeconds: 60,
  blockedOnHumanSeconds: 60,
  claimWaitSeconds: 60,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-attention-service-"));
  state = openDatabase({ stateDir: dir });
  clock = manualClock(1_000_000);
  const bus = createEventBus(clock.now);
  const logger = new Logger("error");

  stores = createStores(state, bus, clock.now);
  const claims = new ClaimService({
    claims: stores.claims,
    bus,
    logger,
    clock: clock.now,
  });
  approvals = new ApprovalService({
    stores,
    bus,
    logger,
    hub: new SessionHub(),
    // Nothing here answers a session-deletion approval, so this fixture's stop is
    // a refusal to be called rather than a silent no-op: a test that started
    // deleting sessions through this service would say so.
    stopSession: () => {
      throw new Error("this fixture stops no sessions");
    },
    claims,
  });

  attention = new AttentionService({
    stores,
    bus,
    logger,
    claims,
    approvals,
    config: { thresholds: THRESHOLDS },
  });

  workstreamId = stores.workstreams.create({ author: humanAuthor }).id;
});

afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

function startSession(): string {
  return stores.sessions.start({
    workstreamId,
    mode: "open",
    launch: {
      model: "fixture-model",
      effort: "medium",
      toolPermissions: INHERIT_APP_TOOLS,
    },
    initiatedBy: humanAuthor,
    runtime: { adapterId: "scripted", ref: `native-${clock.now()}` },
  }).session.id;
}

function alerts(): readonly { alert: string; id: string }[] {
  return attention
    .items()
    .filter((item) => item.feed === "health")
    .map((item) => ({
      alert:
        item.payload.kind === "health"
          ? item.payload.alert
          : "not-a-health-row",
      id: item.id,
    }));
}

describe("idle (§7.2)", () => {
  it("appears once a live session has produced nothing for long enough", () => {
    const sessionId = startSession();
    stores.sessions.appendObservation(sessionId, {
      kind: "output-delta",
      at: clock.now() * 1000,
      text: "working",
    });

    clock.advance(59);
    expect(alerts()).toEqual([]);

    clock.advance(2);
    expect(alerts().map((entry) => entry.alert)).toContain("idle");
    expect(alerts().map((entry) => entry.id)).toContain(
      `health:idle:${sessionId}`,
    );
  });

  it("says nothing once the session has ended — finished is not idle", () => {
    const sessionId = startSession();
    clock.advance(600);
    expect(alerts().map((entry) => entry.alert)).toContain("idle");

    stores.sessions.end(sessionId, {
      kind: "ended-by-user",
      at: clock.now(),
    });
    expect(alerts()).toEqual([]);
  });
});

describe("spinning (§7.2)", () => {
  it("needs cost climbing AND a workspace nothing changed in", () => {
    const sessionId = startSession();
    clock.advance(1);

    // A turn that cost money, and no write anywhere.
    stores.sessions.appendObservation(sessionId, {
      kind: "turn-ended",
      at: clock.now() * 1000,
      turn: 1,
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.05 },
    });

    clock.advance(120);
    expect(alerts().map((entry) => entry.alert)).toContain("spinning");

    // Now it writes something: the workspace changed, and the clock restarts.
    stores.claims.recordWrite(workstreamId, {
      path: claimPath("src/a.ts"),
      holder: sessionAuthor(sessionId as SessionId),
      claimId: null,
      at: clock.now(),
    });
    expect(alerts().map((entry) => entry.alert)).not.toContain("spinning");
  });

  it("stays quiet when the runtime reported no cost at all", () => {
    const sessionId = startSession();
    clock.advance(1);
    stores.sessions.appendObservation(sessionId, {
      kind: "turn-ended",
      at: clock.now() * 1000,
      turn: 1,
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    clock.advance(120);
    // A turn whose runtime priced nothing is no evidence about money.
    expect(alerts().map((entry) => entry.alert)).not.toContain("spinning");
  });
});

describe("conflict predicted, across workstreams (§7.2)", () => {
  it("names two active workstreams writing the same path in one repository", () => {
    const other = stores.workstreams.create({ author: humanAuthor }).id;
    const first = startSession();
    const secondSession = stores.sessions.start({
      workstreamId: other,
      mode: "open",
      launch: {
        model: "fixture-model",
        effort: "medium",
        toolPermissions: INHERIT_APP_TOOLS,
      },
      initiatedBy: humanAuthor,
      runtime: { adapterId: "scripted", ref: "native-2" },
    }).session.id;

    for (const [workstream, sessionId] of [
      [workstreamId, first],
      [other, secondSession],
    ] as const) {
      stores.workspaces.create({
        workstreamId: workstream,
        kind: "git",
        config: { repositoryPath: "/tmp/one-repo" },
        author: humanAuthor,
      });
      stores.claims.recordWrite(workstream, {
        path: claimPath("src/auth.ts"),
        holder: sessionAuthor(sessionId as SessionId),
        claimId: null,
        at: clock.now(),
      });
    }

    const predicted = alerts().filter(
      (entry) => entry.alert === "conflict-predicted",
    );
    expect(predicted).toHaveLength(1);
    expect(predicted[0]?.id).toBe(
      `health:conflict-predicted:${[workstreamId, other].sort().join(":")}`,
    );
  });
});

describe("unanswered and blocked on you (§7.2)", () => {
  it("reports a question nobody answered, and the session waiting on it", () => {
    const sessionId = startSession();
    stores.questions.raise({
      id: "q-1",
      sessionId: sessionId as SessionId,
      requestId: null,
      text: "keep going?",
      options: [
        { id: "yes", label: "yes", detail: null },
        { id: "no", label: "no", detail: null },
      ],
      freeForm: "none",
      attention: null,
      askedAt: clock.now(),
      answer: null,
    });

    // Fresh: neither alert has come due, and one that fired immediately would
    // be noise the operator learns to ignore.
    expect(
      alerts()
        .map((entry) => entry.alert)
        .filter((alert) => alert !== "idle"),
    ).toEqual([]);

    clock.advance(120);
    const kinds = alerts().map((entry) => entry.alert);
    expect(kinds).toContain("unanswered");
    expect(kinds).toContain("blocked-on-you");

    // Two clocks, tracked separately: the question's age and the session's own
    // waiting time are different facts about the same stall (§7.2).
    expect(alerts().map((entry) => entry.id)).toContain(
      "health:unanswered:question:q-1",
    );
    expect(alerts().map((entry) => entry.id)).toContain(
      `health:blocked-on-you:${sessionId}`,
    );
  });

  it("never calls a failed effect an approval nobody answered (#74)", async () => {
    const sessionId = startSession();
    const raised = approvals.raise({
      sessionId,
      ask: destructionAsk({
        toolName: "session_delete",
        target: { kind: "session", id: sessionId },
      }),
    });

    // This fixture's `stopSession` refuses, so approving records a failed effect —
    // the row is answered, and its unfinished gesture is §7.1's own item.
    const answered = await approvals.answer({
      approvalId: raised.id,
      decision: "approve-once",
      actor: humanAuthor,
    });
    expect(answered.effectFailure).not.toBeNull();

    // Well past the unanswered threshold. A human answered this, so the queue must
    // not also carry "an approval has been waiting N minutes" — an alert that ranks
    // above the failure itself, reports a session blocked on the operator when none
    // is, and never clears because nothing ever clears the failure.
    clock.advance(600);
    const ids = attention.items().map((item) => item.id);
    expect(ids).toContain(`approval:${raised.id}:effect-failed`);
    expect(ids).not.toContain(`health:unanswered:approval:${raised.id}`);
    expect(alerts().map((entry) => entry.alert)).not.toContain("unanswered");
  });
});

describe("the derivation as a whole", () => {
  it("publishes what arrived and what left, and never a bare empty list", () => {
    const events: { verb: string; id: string }[] = [];
    stores.bus.subscribe((event) => {
      if (event.entity !== "attention") return;
      events.push({
        verb: event.verb,
        id: event.verb === "deleted" ? event.itemId : event.item.id,
      });
    });

    const sessionId = startSession();
    clock.advance(120);
    attention.refresh();
    expect(events).toEqual([
      { verb: "created", id: `health:idle:${sessionId}` },
    ]);

    // Re-deriving an unchanged world announces nothing: the edge-triggered
    // discipline every surface downstream depends on starts here.
    attention.refresh();
    expect(events).toHaveLength(1);

    stores.sessions.end(sessionId, { kind: "ended-by-user", at: clock.now() });
    attention.refresh();
    expect(events.at(-1)).toEqual({
      verb: "deleted",
      id: `health:idle:${sessionId}`,
    });
  });
});

describe("integration broken (§9.3, Epic 7.2)", () => {
  it("surfaces a broken connection as a health alert, and clears it once reconnected", () => {
    const integration = stores.integrations.connect({
      pluginId: "fake-plugin",
      producerId: "fake-tickets",
      name: "Fake tickets",
      system: "fake",
    });
    stores.integrations.markBroken(integration.id, "authentication failed");

    const derived = attention.derive();
    const broken = derived.find(
      (entry) =>
        entry.item.feed === "health" && entry.item.id.includes(integration.id),
    );
    expect(broken).toBeDefined();
    expect(broken?.item.summary).toContain("authentication failed");

    stores.integrations.markRefreshed(integration.id);
    const recovered = attention.derive();
    expect(
      recovered.some((entry) => entry.item.id.includes(integration.id)),
    ).toBe(false);
  });

  it("never touches or hides the object an integration produced (§3.1)", () => {
    const integration = stores.integrations.connect({
      pluginId: "fake-plugin",
      producerId: "fake-tickets",
      name: "Fake tickets",
      system: "fake",
    });
    const written = stores.objects.write({
      kind: "ticket",
      title: "a ticket",
      renderings: { card: {}, summary: "s", agentContent: "body" },
      external: { system: integration.system, id: "FAKE-1" },
    });
    stores.integrations.markBroken(integration.id, "authentication failed");

    attention.derive();
    expect(stores.objects.get(written.objectId)?.deletedAt ?? null).toBeNull();
    expect(stores.objects.read(written.objectId).renderings.agentContent).toBe(
      "body",
    );
  });
});

/**
 * A deleted session's §7.1 rows (issue #77).
 *
 * AGENTS.md: "hiding is the source's job — a muted item never leaves the server
 * again … and no surface holds a ledger of its own." A deleted session's node went
 * off the board with it, so a row still pointing at that node asks the operator to
 * answer something on a card that is not there.
 */
describe("a deleted session's questions and approvals leave the queue", () => {
  function ask(sessionId: string, id: string): void {
    stores.questions.raise({
      id,
      sessionId: sessionId as SessionId,
      requestId: null,
      text: "keep going?",
      options: [{ id: "yes", label: "yes", detail: null }],
      freeForm: "none",
      attention: null,
      askedAt: clock.now(),
      answer: null,
    });
  }

  it("hides the question, and the health alert that timed it", () => {
    const sessionId = startSession();
    ask(sessionId, "q-deleted");
    clock.advance(120);

    expect(attention.items().map((item) => item.id)).toContain(
      "question:q-deleted",
    );

    stores.sessions.end(sessionId, {
      kind: "stopped",
      by: "user",
      at: clock.now(),
    });
    stores.sessions.delete(sessionId);

    const ids = attention.items().map((item) => item.id);
    expect(ids).not.toContain("question:q-deleted");
    // The §7.2 alert reads the same list, so it cannot outlive the row it timed.
    expect(ids).not.toContain("health:unanswered:question:q-deleted");
  });

  it("hides an approval that is still asking, and one whose effect failed", async () => {
    const sessionId = startSession();
    const asking = approvals.raise({
      sessionId,
      ask: destructionAsk({
        toolName: "object_delete",
        target: { kind: "object", id: "obj-1" },
      }),
    });
    const failing = approvals.raise({
      sessionId,
      ask: destructionAsk({
        toolName: "session_delete",
        target: { kind: "session", id: sessionId },
      }),
    });
    // This fixture's stop refuses, so approving records a failed effect — §7.1's
    // other approval row, and it points at the same node.
    await approvals.answer({
      approvalId: failing.id,
      decision: "approve-once",
      actor: humanAuthor,
    });

    const before = attention.items().map((item) => item.id);
    expect(before).toContain(`approval:${asking.id}`);
    expect(before).toContain(`approval:${failing.id}:effect-failed`);

    stores.sessions.end(sessionId, {
      kind: "stopped",
      by: "user",
      at: clock.now(),
    });
    stores.sessions.delete(sessionId);

    // Past §7.2's threshold, so the `unanswered` alert the approval times is
    // genuinely derived and then hidden rather than merely too young to exist.
    // That alert reaches the filter only because `pendingAsks` builds its target
    // through `sessionTarget`, which is the hop most likely to be lost.
    clock.advance(120);
    const after = attention.items().map((item) => item.id);
    expect(after).not.toContain(`approval:${asking.id}`);
    expect(after).not.toContain(`approval:${failing.id}:effect-failed`);
    expect(after).not.toContain(`health:unanswered:approval:${asking.id}`);
  });

  it("brings them back when the session is restored, having withdrawn nothing", () => {
    const sessionId = startSession();
    ask(sessionId, "q-restored");
    const raised = approvals.raise({
      sessionId,
      ask: destructionAsk({
        toolName: "object_delete",
        target: { kind: "object", id: "obj-1" },
      }),
    });

    stores.sessions.end(sessionId, {
      kind: "stopped",
      by: "user",
      at: clock.now(),
    });
    stores.sessions.delete(sessionId);
    expect(attention.items()).toHaveLength(0);

    // Hidden, never withdrawn: the question and the approval are still answerable
    // facts, and a deleted session is restorable (§3.6, principle 10) — so a
    // restore is all it takes, with nothing having to undo anything.
    stores.sessions.restore(sessionId);
    const ids = attention.items().map((item) => item.id);
    expect(ids).toContain("question:q-restored");
    expect(ids).toContain(`approval:${raised.id}`);
  });

  it("keeps an ended session's rows, which is a different fact", () => {
    const sessionId = startSession();
    ask(sessionId, "q-ended");
    stores.sessions.end(sessionId, { kind: "completed", at: clock.now() });

    // Still on the board, so still asking: §7.1 exists to surface exactly this.
    expect(attention.items().map((item) => item.id)).toContain(
      "question:q-ended",
    );
  });
});
