import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dayStartSeconds,
  humanAuthor,
  DEFAULT_BUDGET_WARN_FRACTION,
  DEFAULT_GLOBAL_CEILING_MICROS,
  INHERIT_APP_TOOLS,
} from "@plotroom/core";
import { eq } from "drizzle-orm";
import { manualClock, type ManualClock } from "@plotroom/core/testing";
import { BudgetStore } from "./budget-store.js";
import { broadcastCause } from "./spend-store.js";
import { sessions as sessionRows } from "./schema.js";
import { openDatabase, type PlotroomDatabase } from "./client.js";
import { SessionStore } from "./session-store.js";
import { SpendStore } from "./spend-store.js";
import { WorkstreamStore } from "./workstream-store.js";

let dir: string;
let state: PlotroomDatabase;
let clock: ManualClock;
let budgets: BudgetStore;
let spend: SpendStore;
let sessions: SessionStore;
let workstreamId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-budgets-"));
  state = openDatabase({ stateDir: dir });
  clock = manualClock();
  budgets = new BudgetStore(state, clock.now);
  spend = new SpendStore(state, clock.now);
  sessions = new SessionStore(state, clock.now);
  workstreamId = new WorkstreamStore(state, clock.now).create({
    author: humanAuthor,
  }).id;
});

afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

function startSession() {
  return sessions.start({
    workstreamId,
    mode: "open",
    launch: {
      model: "fixture-model",
      effort: "medium",
      toolPermissions: INHERIT_APP_TOOLS,
    },
    initiatedBy: humanAuthor,
    runtime: { adapterId: "scripted", ref: "native-1" },
  }).session;
}

describe("the shipped default global ceiling (§8)", () => {
  it("is present on a fresh install, as a row the operator can see", () => {
    // "The product ships with a default global ceiling — a real number the
    // operator can raise or remove, not an empty field with a recommendation."
    // A row rather than a constant resolved at read time, which is what makes it
    // visible, editable, and removable-for-good.
    const global = budgets.global();

    expect(global).not.toBeNull();
    expect(global?.limitMicros).toBe(DEFAULT_GLOBAL_CEILING_MICROS);
    expect(global?.period).toBe("day");
    expect(global?.warnFraction).toBe(DEFAULT_BUDGET_WARN_FRACTION);
    // Named as the product's own number, so an operator who raised it can tell
    // their number from ours.
    expect(global?.origin).toBe("shipped-default");
  });

  it("becomes the operator's once they set one, and stays a single row", () => {
    const raised = budgets.set({ scope: "global", limitMicros: 100_000_000 });

    expect(raised.origin).toBe("authored");
    expect(budgets.list().filter((one) => one.scope === "global")).toHaveLength(
      1,
    );
  });

  it("stays removed once removed — there is no second way to say 'no cap'", () => {
    const global = budgets.global();
    expect(global).not.toBeNull();

    budgets.remove(global?.id ?? "");

    expect(budgets.global()).toBeNull();
    // And re-reading does not resurrect it from a default somewhere.
    expect(new BudgetStore(state, clock.now).global()).toBeNull();
  });
});

describe("workstream budgets", () => {
  it("names the workstream it binds, and refuses one that does not", () => {
    const budget = budgets.set({
      scope: "workstream",
      workstreamId,
      limitMicros: 5_000_000,
    });

    expect(budget.workstreamId).toBe(workstreamId);
    // A total period by default: a workstream is a piece of work, not a day.
    expect(budget.period).toBe("total");
    expect(() => budgets.set({ scope: "workstream", limitMicros: 1 })).toThrow(
      /names the workstream/,
    );
  });

  it("replaces rather than accumulates, so 'the tightest wins' stays about scopes", () => {
    budgets.set({ scope: "workstream", workstreamId, limitMicros: 5_000_000 });
    const raised = budgets.set({
      scope: "workstream",
      workstreamId,
      limitMicros: 9_000_000,
    });

    expect(raised.limitMicros).toBe(9_000_000);
    expect(budgets.forWorkstream(workstreamId)?.limitMicros).toBe(9_000_000);
    expect(
      budgets.list().filter((one) => one.workstreamId === workstreamId),
    ).toHaveLength(1);
  });
});

describe("the notice ledger (§8)", () => {
  it("records a warning once, so a restart cannot say it twice", () => {
    const session = startSession();
    const first = budgets.recordNotice({
      sessionId: session.id,
      bindingKind: "global",
      bindingId: "budget_global_default",
      kind: "near-cap",
      remainingMicros: 1_000,
    });
    const second = budgets.recordNotice({
      sessionId: session.id,
      bindingKind: "global",
      bindingId: "budget_global_default",
      kind: "near-cap",
      remainingMicros: 500,
    });

    expect(first).not.toBeNull();
    // Null means "already said": the caller reads that as say nothing.
    expect(second).toBeNull();
    expect(budgets.notices(session.id)).toHaveLength(1);
  });

  it("keeps one row per binding and kind — two caps are two things to be told", () => {
    const session = startSession();
    budgets.recordNotice({
      sessionId: session.id,
      bindingKind: "run",
      bindingId: "run_1",
      kind: "near-cap",
      remainingMicros: 10,
    });
    budgets.recordNotice({
      sessionId: session.id,
      bindingKind: "global",
      bindingId: "budget_global_default",
      kind: "near-cap",
      remainingMicros: 10,
    });
    budgets.recordNotice({
      sessionId: session.id,
      bindingKind: "run",
      bindingId: "run_1",
      kind: "stopped",
      remainingMicros: 0,
    });

    expect(budgets.notices(session.id)).toHaveLength(3);
  });
});

describe("spend outlives the sessions that spent it (§8)", () => {
  it("survives the session ending and being soft-deleted", () => {
    const session = startSession();
    spend.attribute({
      chain: [session.id],
      workstreamId,
      spend: {
        sessionId: session.id,
        amountUsd: 2,
        basis: "reported",
        at: clock.now(),
      },
    });

    sessions.end(session.id, { kind: "ended-by-user", at: clock.now() });
    // Deletion of a session record is a *soft* one (principle 10), which is what
    // keeps the spend rows reachable: the FK cascade only fires on a hard delete,
    // and nothing in the product performs one.
    state.db
      .update(sessionRows)
      .set({ deletedAt: clock.now() })
      .where(eq(sessionRows.id, session.id))
      .run();

    // "Cost outlives the session that spent it ... totals do not reset when
    // sessions end." Nor when the record is tidied off the board.
    expect(spend.fleetTotal().amountMicros).toBe(2_000_000);
    expect(spend.workstreamTotal(workstreamId).amountMicros).toBe(2_000_000);
    expect(spend.sessionTotal(session.id).amountMicros).toBe(2_000_000);
  });

  it("answers 'today' as a window over the ledger, never as a reset", () => {
    const session = startSession();
    const yesterday = dayStartSeconds(clock.now()) - 60;
    spend.attribute({
      chain: [session.id],
      workstreamId,
      spend: {
        sessionId: session.id,
        amountUsd: 1,
        basis: "reported",
        at: yesterday,
      },
    });

    // The row is still there; it is simply not today's.
    expect(spend.fleetTotal().amountMicros).toBe(1_000_000);
    expect(spend.todayTotal().amountMicros).toBe(0);
  });

  it("totals a named set of spenders once each, for a batch's cap", () => {
    const first = startSession();
    const second = startSession();
    const outside = startSession();

    for (const [session, amount] of [
      [first, 1],
      [second, 2],
      [outside, 4],
    ] as const) {
      spend.attribute({
        chain: [session.id],
        workstreamId,
        spend: {
          sessionId: session.id,
          amountUsd: amount,
          basis: "reported",
          at: clock.now(),
        },
      });
    }

    // What a batch's cap must count: the sessions in it, and nothing else.
    expect(spend.sessionsTotal([first.id, second.id]).amountMicros).toBe(
      3_000_000,
    );
    // An empty batch has spent nothing; it does not read as "everything".
    expect(spend.sessionsTotal([]).amountMicros).toBe(0);
  });

  it("counts what a batch's entries delegated, not only what they spent", () => {
    // The evasion this closes: three entries under one $5 batch cap, each
    // delegating its work to a child. Counting only the entries' `own` rows, the
    // batch would see nothing at all and its cap would never move, however much
    // the children spent — which is a cap the batch can walk around by delegating
    // (§3.6's "its spend counts against every budget that binds the initiating
    // work", which the batch binding is one of).
    const entries = [startSession(), startSession(), startSession()];

    for (const entry of entries) {
      const child = startSession();
      spend.attribute({
        chain: [child.id, entry.id],
        workstreamId,
        spend: {
          sessionId: child.id,
          amountUsd: 2,
          basis: "reported",
          at: clock.now(),
        },
      });
    }

    const batch = spend.sessionsTotal(entries.map((entry) => entry.id));

    // $6 against a $5 cap: the batch is over, and says so.
    expect(batch.amountMicros).toBe(6_000_000);
    // Each entry sees its own child, and only its own — summing the batch is
    // summing the entries, because siblings are never in each other's chains.
    for (const entry of entries) {
      expect(spend.sessionTotal(entry.id).amountMicros).toBe(2_000_000);
    }
  });

  it("names the biggest spender by who spent, not by who delegated", () => {
    const parent = startSession();
    const child = startSession();

    spend.attribute({
      chain: [child.id, parent.id],
      workstreamId,
      spend: {
        sessionId: child.id,
        amountUsd: 3,
        basis: "reported",
        at: clock.now(),
      },
    });
    spend.attribute({
      chain: [parent.id],
      workstreamId,
      spend: {
        sessionId: parent.id,
        amountUsd: 1,
        basis: "reported",
        at: clock.now(),
      },
    });

    const bySession = spend.bySession();
    expect(bySession[0]?.sessionId).toBe(child.id);
    expect(bySession[0]?.amountMicros).toBe(3_000_000);
    // The parent's budget is charged $4, but it only *spent* $1 — and the fleet
    // total counts each dollar once.
    expect(spend.sessionTotal(parent.id).amountMicros).toBe(4_000_000);
    expect(spend.fleetTotal().amountMicros).toBe(4_000_000);
  });
});

describe("a charge names its cause (§6.5, migration 22)", () => {
  it("keeps two broadcasts from one sender as two charges, not one replaced", () => {
    const sender = startSession();
    const recipient = startSession();

    // Two broadcasts, each inducing $1 of the same recipient's work. Keyed on
    // (charged session, spender) alone, the second silently replaced the first and
    // the sender was billed once for two broadcasts.
    for (const broadcastId of ["bcast_1", "bcast_2"]) {
      spend.attribute({
        chain: [sender.id],
        workstreamId,
        spend: {
          sessionId: recipient.id,
          amountUsd: 1,
          basis: "reported",
          at: clock.now(),
        },
        cause: broadcastCause(broadcastId),
      });
    }

    expect(spend.sessionTotal(sender.id).amountMicros).toBe(2_000_000);
    expect(spend.forSession(sender.id)).toHaveLength(2);
  });

  it("replays one broadcast's charge without adding a second", () => {
    const sender = startSession();
    const recipient = startSession();

    // Same cause twice: the same charge restated, which is the idempotency the
    // pair key gave and the cause key must keep (principle 9, applied to money).
    for (let attempt = 0; attempt < 2; attempt += 1) {
      spend.attribute({
        chain: [sender.id],
        workstreamId,
        spend: {
          sessionId: recipient.id,
          amountUsd: 1,
          basis: "reported",
          at: clock.now(),
        },
        cause: broadcastCause("bcast_1"),
      });
    }

    expect(spend.sessionTotal(sender.id).amountMicros).toBe(1_000_000);
    expect(spend.forSession(sender.id)).toHaveLength(1);
  });

  it("never lets an induced slice and a cumulative total overwrite each other", () => {
    const sender = startSession();
    const recipient = startSession();

    // The sender is also the recipient's ancestor — the overlap §6.5 accepts. The
    // fold charges it the recipient's *cumulative* total; a broadcast charges it a
    // *slice*. Sharing a key, whichever wrote last destroyed the other's number.
    spend.attribute({
      chain: [recipient.id, sender.id],
      workstreamId,
      spend: {
        sessionId: recipient.id,
        amountUsd: 10,
        basis: "reported",
        at: clock.now(),
      },
    });
    spend.attribute({
      chain: [sender.id],
      workstreamId,
      spend: {
        sessionId: recipient.id,
        amountUsd: 1,
        basis: "reported",
        at: clock.now(),
      },
      cause: broadcastCause("bcast_1"),
    });

    // Both survive, and the accounting row still says what the recipient's whole
    // session cost rather than what one broadcast induced.
    const rows = spend.forSession(sender.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.amountMicros).sort((a, b) => a - b)).toEqual([
      1_000_000, 10_000_000,
    ]);

    // The fold restating a grown total still replaces its own row and touches no
    // other: $10 becomes $12, the induced $1 stays $1.
    spend.attribute({
      chain: [recipient.id, sender.id],
      workstreamId,
      spend: {
        sessionId: recipient.id,
        amountUsd: 12,
        basis: "reported",
        at: clock.now(),
      },
    });

    expect(spend.sessionTotal(sender.id).amountMicros).toBe(13_000_000);
    // And the fleet total is unmoved by an induced charge: it sums `own` rows, and
    // an induced row is always `descendant`, so the recipient's turn is counted
    // once however many senders caused part of it.
    expect(spend.fleetTotal().amountMicros).toBe(12_000_000);
  });
});
