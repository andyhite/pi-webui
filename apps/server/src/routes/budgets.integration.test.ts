import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeScript } from "../runtime/scripted.js";
import {
  at,
  boot,
  cleanupHarnesses,
  command,
  endedSession,
  list,
  repository,
  run,
  str,
  waitFor,
  type Harness,
} from "../testing/harness.js";

/**
 * Budgets, enforced (§8, §3.6, principles 2 and 11).
 *
 * These drive the real server with the scripted runtime, which shares every line
 * downstream of the seam with the pi adapter — the observation log, the accounting
 * fold, the injection ledger, the end-state taxonomy — so what they prove about
 * enforcement is true of a real session too (decision 0001).
 *
 * The four things being proved, in the spec's own words:
 *
 * 1. **"The product ships with a default global ceiling — a real number."**
 * 2. **"A session can see what remains of every budget that binds it"** —
 *    including, transitively, the caps of every session that initiated it.
 * 3. **"Near a cap, the defined behavior is to stop cleanly: wrap up, report"** —
 *    the session is *told*, once, with the number and the instruction.
 * 4. **"Reaching a cap cuts work off as its own outcome, distinct from failure,
 *    which a retry must not blindly re-run"** — and the chain that paid for it is
 *    told it was not a failure.
 */
afterEach(cleanupHarnesses);

/** One priced turn, then the session stays live: only PlotRoom can end it. */
const spends = (costUsd: number): RuntimeScript => ({
  acts: [
    {
      on: "start",
      steps: [
        { observation: { kind: "turn-started", turn: 1 } },
        {
          observation: {
            kind: "turn-ended",
            turn: 1,
            usage: { inputTokens: 100, outputTokens: 50, costUsd },
          },
        },
        // A real pause, so the stream is not already finished when PlotRoom
        // decides: enforcement lands between turns, exactly where a runtime
        // accepts input.
        { delay: { ms: 2_000 } },
        { observation: { kind: "turn-started", turn: 2 } },
      ],
    },
  ],
});

/** Two priced turns: the first warns, the second exhausts. */
const spendsTwice = (first: number, second: number): RuntimeScript => ({
  acts: [
    {
      on: "start",
      steps: [
        { observation: { kind: "turn-started", turn: 1 } },
        {
          observation: {
            kind: "turn-ended",
            turn: 1,
            usage: { inputTokens: 100, outputTokens: 50, costUsd: first },
          },
        },
        { delay: { ms: 200 } },
        { observation: { kind: "turn-started", turn: 2 } },
        {
          observation: {
            kind: "turn-ended",
            turn: 2,
            usage: { inputTokens: 100, outputTokens: 50, costUsd: second },
          },
        },
        { delay: { ms: 2_000 } },
      ],
    },
  ],
});

/**
 * A harness whose scripted runtime has a default script, for the gestures that do
 * not carry one: a scoped run reaches the run path without naming a script.
 */
async function bootWithScript(
  script: RuntimeScript,
  concurrencyLimit = 4,
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "plotroom-budget-script-"));
  const scriptPath = join(dir, "script.json");
  writeFileSync(scriptPath, JSON.stringify(script), "utf8");

  return boot({
    ...repository(),
    concurrencyLimit,
    runtime: { adapterId: "scripted", scriptPath },
  });
}

async function runCapped(
  harness: Harness,
  commandId: string,
  script: RuntimeScript,
  spendCapMicros: number,
): Promise<unknown> {
  return harness.ok("/runs", {
    method: "POST",
    body: {
      commandId,
      initiationKey: `budget-${Math.random().toString(36).slice(2)}`,
      runtime: { script },
      spendCapMicros,
    },
  });
}

/** Wait until a session's recorded end has a particular kind. */
async function endedAs(
  harness: Harness,
  sessionId: string,
  kind: string,
): Promise<unknown> {
  return waitFor(async () => {
    const read = await harness.ok(`/sessions/${sessionId}`);
    return at(read, "session.end.kind") === kind ? read : null;
  }, `session ${sessionId} to end as ${kind}`);
}

async function injections(
  harness: Harness,
  sessionId: string,
): Promise<unknown[]> {
  return list(await harness.ok(`/sessions/${sessionId}`), "injections");
}

describe("the shipped default global ceiling (§8, principle 2)", () => {
  it("is present on a fresh install, as a row with a real number", async () => {
    const harness = await boot(repository());

    const read = await harness.ok("/budgets");
    const budgets = list(read, "budgets");
    const global = budgets.find(
      (entry) => at(entry, "budget.scope") === "global",
    );

    expect(global).toBeDefined();
    // $25/day, decided — not zero, not absent, and not a recommendation in prose.
    expect(at(global, "budget.limitMicros")).toBe(25_000_000);
    expect(at(global, "budget.period")).toBe("day");
    expect(at(global, "budget.origin")).toBe("shipped-default");
    // The guidance travels with the read, so a session that looks early still
    // hears that racing the budget is a failure mode (§8).
    expect(String(at(read, "guidance"))).toContain("Do not race the budget");
  });

  it("is the operator's to raise and to remove, and removal says what it means", async () => {
    const harness = await boot(repository());
    const before = list(await harness.ok("/budgets"), "budgets");
    const id = str(
      before.find((entry) => at(entry, "budget.scope") === "global"),
      "budget.id",
    );

    const raised = await harness.ok("/budgets", {
      method: "POST",
      body: { scope: "global", limitMicros: 100_000_000 },
    });
    expect(at(raised, "budget.budget.limitMicros")).toBe(100_000_000);
    expect(at(raised, "budget.budget.origin")).toBe("authored");

    const removed = await harness.ok(`/budgets/${id}`, { method: "DELETE" });
    // Removing the ceiling is allowed — it is the operator's product — and the
    // consequence is stated rather than left to be discovered.
    expect(String(at(removed, "warning"))).toContain("unbounded spend");
    expect(list(await harness.ok("/budgets"), "budgets")).toHaveLength(0);
  });

  it("refuses a workstream budget with no workstream, and the reverse", async () => {
    const harness = await boot(repository());

    const noWorkstream = await harness.call("/budgets", {
      method: "POST",
      body: { scope: "workstream", limitMicros: 1_000_000 },
    });
    expect(noWorkstream.status).toBe(409);

    const globalWithOne = await harness.call("/budgets", {
      method: "POST",
      body: { scope: "global", workstreamId: "ws_nope", limitMicros: 1 },
    });
    expect(globalWithOne.status).toBe(409);
  });
});

describe("a session reads what binds it (§8)", () => {
  it("names every binding and the tightest one, transitively", async () => {
    const harness = await boot(repository());
    const parentFixture = await command(harness, { lifecycle: "open" });
    const parent = str(
      await runCapped(
        harness,
        parentFixture.commandId,
        spends(0.01),
        20_000_000,
      ),
      "session.id",
    );

    const childFixture = await command(harness, {
      lifecycle: "open",
      name: "Delegated work",
    });
    const child = str(
      await run(harness, childFixture.commandId, spends(0.01), {
        actor: `session:${parent}`,
      }),
      "session.id",
    );

    const read = await harness.ok(`/sessions/${child}/budget`);
    const kinds = list(read, "budget.bindings").map((one) => at(one, "kind"));

    // The child accepted no cap of its own and its workstream has no budget — and
    // it is still bound by its parent's run cap and by the global ceiling. That is
    // the transitive guarantee: "its spend counts against every budget that binds
    // the initiating work" (§3.6).
    expect(kinds).toContain("run");
    expect(kinds).toContain("global");
    expect(at(read, "budget.state")).toBe("ok");
    // A formatted figure beside the micros, never instead of them.
    expect(String(at(read, "remaining"))).toMatch(/^\$/);
    expect(String(at(read, "guidance"))).toContain("Wrap up cleanly");
  });

  it("includes the batch's cap, which §8 counts as a run-scope cap", async () => {
    // A scoped run enters the ordinary run path without naming a script, so the
    // scripted runtime is given a default one — exactly as a real launch would name
    // a real adapter.
    const harness = await bootWithScript(spends(0.01));
    const fixture = await command(harness, { lifecycle: "open" });

    // A scoped gesture accepts one cap for the whole scope (§4.1), so a session it
    // admitted is bound by the batch as well as by its own run.
    const initiated = await harness.ok("/run-scopes", {
      method: "POST",
      body: {
        scope: "one",
        scopeId: fixture.commandId,
        initiationKey: "batch-binding",
        spendCapMicros: 5_000_000,
      },
    });

    // The scoped response describes the batch and its entries; the session id is
    // on the entry the drain admitted.
    const sessionId = await waitFor(async () => {
      const batch = await harness.ok(
        `/run-batches/${str(initiated, "batch.id")}`,
      );
      const found = list(batch, "entries").find(
        (entry) => at(entry, "sessionId") !== null,
      );
      return found === undefined ? null : str(found, "sessionId");
    }, "the scoped run to be admitted");

    const bindings = list(
      await harness.ok(`/sessions/${sessionId}/budget`),
      "budget.bindings",
    );

    const batch = bindings.find((one) => at(one, "kind") === "batch");
    expect(batch).toBeDefined();
    // A batch cap is a `run`-scope cap, which is what "a single run or batch"
    // means — so an out-of-budget stop on one records scope `run`.
    expect(at(batch, "scope")).toBe("run");
    expect(at(batch, "limitMicros")).toBe(5_000_000);
  });

  it("counts what a batch entry delegated against the batch's cap", async () => {
    // The evasion this closes: a batch cap that counted only its entries' *own*
    // spend is a cap any entry can walk around by delegating — three entries under
    // one $5 cap could hand $5 each to a child and the batch would never move.
    // A batch cap binds transitively for the same reason a run cap does (§3.6).
    const harness = await bootWithScript(spends(0.01));
    const fixture = await command(harness, { lifecycle: "open" });

    const initiated = await harness.ok("/run-scopes", {
      method: "POST",
      body: {
        scope: "one",
        scopeId: fixture.commandId,
        initiationKey: "batch-delegation",
        spendCapMicros: 5_000_000,
      },
    });

    const entrySession = await waitFor(async () => {
      const batch = await harness.ok(
        `/run-batches/${str(initiated, "batch.id")}`,
      );
      const found = list(batch, "entries").find(
        (entry) => at(entry, "sessionId") !== null,
      );
      return found === undefined ? null : str(found, "sessionId");
    }, "the scoped run to be admitted");

    // The entry delegates $2 of work to a child that is not in the batch at all.
    const delegated = await command(harness, {
      lifecycle: "open",
      name: "Delegated by a batch entry",
    });
    const child = str(
      await run(harness, delegated.commandId, spends(2), {
        actor: `session:${entrySession}`,
      }),
      "session.id",
    );

    const batch = await waitFor(async () => {
      const read = await harness.ok(`/sessions/${entrySession}/budget`);
      const binding = list(read, "budget.bindings").find(
        (one) => at(one, "kind") === "batch",
      );
      return at(binding, "spentMicros") === 0 ? null : (binding ?? null);
    }, "the delegated spend to reach the batch's cap");

    // The child's $2 plus the entry's own $0.01: the batch sees money it never
    // spent itself, which is the whole point of a cap over a gesture.
    expect(at(batch, "spentMicros")).toBe(2_010_000);
    expect(child).not.toBe(entrySession);
  });

  it("reports a workstream's own budget beside the ceiling", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, { lifecycle: "open" });
    await harness.ok("/budgets", {
      method: "POST",
      body: {
        scope: "workstream",
        workstreamId: fixture.workstream,
        limitMicros: 2_000_000,
      },
    });

    const read = await harness.ok(`/workstreams/${fixture.workstream}/budget`);
    expect(list(read, "budget.bindings").map((one) => at(one, "kind"))).toEqual(
      ["workstream", "global"],
    );
    expect(at(read, "budget.tightest.limitMicros")).toBe(2_000_000);
  });
});

describe("near a cap, the session is told to wrap up cleanly (§8)", () => {
  it("delivers the remaining budget and the instruction, then stops at the cap", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, { lifecycle: "open" });
    await harness.ok("/budgets", {
      method: "POST",
      body: {
        scope: "workstream",
        workstreamId: fixture.workstream,
        limitMicros: 1_000_000,
        warnFraction: 0.9,
      },
    });

    // $0.95 of a $1 workstream budget, then another $0.10.
    const session = str(
      await run(harness, fixture.commandId, spendsTwice(0.95, 0.1)),
      "session.id",
    );

    const warned = await waitFor(async () => {
      const rows = await injections(harness, session);
      const notice = rows.find((row) => at(row, "origin") === "budget-notice");
      return notice ?? null;
    }, "the near-cap warning to be delivered");

    const text = String(at(warned, "text"));
    expect(text).toContain("Budget warning");
    expect(text).toContain("$0.05");
    expect(text).toContain("Wrap up cleanly");
    // §8 names the failure mode explicitly, so the guidance does too.
    expect(text).toContain("Do not race the budget");
    // Delivered as a turn, not merely queued (§6.5's two facts).
    expect(at(warned, "deliveredAt")).not.toBeNull();

    // And it renders as PlotRoom's own report rather than as an injection nobody
    // authored: the transcript's `feedback` entry, sourced to the budget.
    const transcript = await harness.ok(`/sessions/${session}/transcript`);
    const feedback = list(transcript, "turns")
      .flatMap((turn) => list(turn, "entries"))
      .filter((entry) => at(entry, "kind") === "feedback");
    expect(feedback.map((entry) => at(entry, "source"))).toContain("budget");

    // The second turn takes it past the cap, and PlotRoom stops it there.
    const ended = await endedAs(harness, session, "out-of-budget");
    expect(at(ended, "session.end.scope")).toBe("workstream");

    // Told once, not once per turn: the notice ledger is a row, so a restart
    // between the warning and the cap could not repeat it either.
    const warnings = (await injections(harness, session)).filter(
      (row) =>
        at(row, "origin") === "budget-notice" &&
        String(at(row, "text")).includes("Budget warning"),
    );
    expect(warnings).toHaveLength(1);
  });
});

describe("out of budget is its own outcome, not a failure (§3.6, principle 11)", () => {
  it("stops a delegated child on its parent's cap and tells the parent why", async () => {
    const harness = await boot(repository());

    // The parent accepts a $1 cap and spends almost nothing itself.
    const parentFixture = await command(harness, { lifecycle: "open" });
    const parent = str(
      await runCapped(
        harness,
        parentFixture.commandId,
        spends(0.01),
        1_000_000,
      ),
      "session.id",
    );

    // The child spends $5 — nothing about its own scopes is exceeded, and the
    // cap it blows through is its parent's.
    const childFixture = await command(harness, {
      lifecycle: "open",
      name: "Expensive delegate",
    });
    const child = str(
      await run(harness, childFixture.commandId, spends(5), {
        actor: `session:${parent}`,
      }),
      "session.id",
    );

    const ended = await endedAs(harness, child, "out-of-budget");

    // The end state, and the facts every surface reads from it: not a failure,
    // nobody stopped it, and a retry may not blindly re-run it (§3.6).
    expect(at(ended, "session.end.scope")).toBe("run");
    expect(at(ended, "end.failed")).toBe(false);
    expect(at(ended, "end.stopped")).toBe(false);
    expect(at(ended, "end.safeToRetryBlindly")).toBe(false);
    expect(at(ended, "end.wantsDecision")).toBe(true);
    expect(at(ended, "end.resumable")).toBe(true);

    // The run history says the same thing, in its own vocabulary.
    const runId = str(ended, "runId");
    expect(at(await harness.ok(`/runs/${runId}`), "run.status")).toBe(
      "out_of_budget",
    );

    // And the chain that paid for it is told — as PlotRoom's own report, naming
    // the session, and saying explicitly that it did not fail.
    const notice = await waitFor(async () => {
      const rows = await injections(harness, parent);
      return rows.find((row) => at(row, "origin") === "budget-notice") ?? null;
    }, "the parent to be told its child ran out of budget");

    const text = String(at(notice, "text"));
    expect(text).toContain(child);
    expect(text).toContain("did not fail");
    expect(text).toContain("must not blindly re-run");
  });

  it("refuses a further run against an exhausted budget rather than starting one", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, { lifecycle: "open" });
    await harness.ok("/budgets", {
      method: "POST",
      body: {
        scope: "workstream",
        workstreamId: fixture.workstream,
        limitMicros: 500_000,
      },
    });

    const first = str(
      await run(harness, fixture.commandId, spends(1)),
      "session.id",
    );
    await endedAs(harness, first, "out-of-budget");

    // The preview says so before the run does, and says the same thing: a preview
    // that reported "ready" here would be the one thing it exists not to do (§4.1).
    const preview = await harness.ok(`/commands/${fixture.commandId}/preview`);
    expect(at(preview, "preview.runnable")).toBe(false);
    expect(
      list(preview, "preview.blockers").map((one) => at(one, "reason")),
    ).toContain("out_of_budget");
    expect(at(preview, "budget.state")).toBe("at-cap");

    const refused = await harness.call("/runs", {
      method: "POST",
      body: {
        commandId: fixture.commandId,
        initiationKey: "after-the-cap",
        runtime: { script: spends(0.01) },
      },
    });
    expect(refused.status).toBe(409);
    expect(String(at(refused.body, "error.message"))).toContain("exhausted");
  });

  it("pauses a batch rather than failing it, naming out-of-budget as the reason", async () => {
    // Two commands, one slot: the first runs, the second queues behind it. The
    // first runs out of money, and §4.1's rule is that the batch **pauses** —
    // "resumable once the human addresses it" — rather than being called failed.
    const harness = await bootWithScript(spends(1), 1);

    // A producer and a consumer wired to its output placeholder, so the subgraph
    // has two commands in dependency order and only one slot to run them in.
    const producer = await command(harness, { name: "Produce" });
    const outputs = list(
      await harness.ok(`/commands/${producer.commandId}`),
      "outputs",
    );
    const consumer = await command(harness, {
      workstreamId: producer.workstream,
      name: "Consume",
    });
    const placeholderNode = await harness.ok("/nodes", {
      method: "POST",
      body: {
        role: "content",
        refId: str(outputs[0], "id"),
        workstreamId: producer.workstream,
      },
    });
    await harness.ok("/edges", {
      method: "POST",
      body: {
        from: str(placeholderNode, "node.id"),
        to: consumer.commandNodeId,
      },
    });

    await harness.ok("/budgets", {
      method: "POST",
      body: {
        scope: "workstream",
        workstreamId: producer.workstream,
        limitMicros: 500_000,
      },
    });

    const initiated = await harness.ok("/run-scopes", {
      method: "POST",
      body: {
        scope: "subgraph",
        scopeId: producer.commandId,
        initiationKey: "budget-batch",
      },
    });
    const batchId = str(initiated, "batch.id");

    const paused = await waitFor(async () => {
      const read = await harness.ok(`/run-batches/${batchId}`);
      return at(read, "batch.state") === "paused" ? read : null;
    }, "the batch to pause on an out-of-budget run");

    // The reason names the outcome, so "address it and resume" is actionable: the
    // thing to address is a cap, not a bug.
    expect(String(at(paused, "batch.pauseReason"))).toContain("out-of-budget");
    const details = list(paused, "entries").map((entry) => at(entry, "detail"));
    expect(details).toContain("out-of-budget");
  });
});

describe("the fleet view (§8, §11)", () => {
  it("answers today's total, the biggest spender, and running against the limit", async () => {
    const harness = await boot({ ...repository(), concurrencyLimit: 3 });
    const cheap = await command(harness, { lifecycle: "open" });
    const dear = await command(harness, {
      lifecycle: "open",
      name: "Expensive",
    });

    const cheapSession = str(
      await run(harness, cheap.commandId, spends(0.01)),
      "session.id",
    );
    const dearSession = str(
      await run(harness, dear.commandId, spends(2)),
      "session.id",
    );

    const fleet = await waitFor(async () => {
      const read = await harness.ok("/fleet");
      return at(read, "today.spentMicros") === 2_010_000 ? read : null;
    }, "both sessions' spend to be attributed");

    expect(at(fleet, "biggestSpender.sessionId")).toBe(dearSession);
    expect(at(fleet, "biggestSpender.spentMicros")).toBe(2_000_000);
    expect(at(fleet, "concurrency.limit")).toBe(3);
    expect(at(fleet, "concurrency.running")).toBe(2);
    // The ceiling is in the same answer, so "what is left" needs no second call.
    expect(
      list(fleet, "budgets").map((entry) => at(entry, "budget.scope")),
    ).toContain("global");

    expect(cheapSession).not.toBe(dearSession);
  });

  it("has no biggest spender when nothing has spent — not a $0 placeholder", async () => {
    const harness = await boot(repository());
    const fleet = await harness.ok("/fleet");

    expect(at(fleet, "biggestSpender")).toBeNull();
    expect(at(fleet, "today.spentMicros")).toBe(0);
  });
});

describe("the session timeline (§8, §11)", () => {
  it("says where the time and money went, for a finished session", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, { lifecycle: "open" });
    const session = str(
      await run(harness, fixture.commandId, {
        acts: [
          {
            on: "start",
            steps: [
              { observation: { kind: "turn-started", turn: 1 } },
              {
                observation: {
                  kind: "tool-started",
                  toolName: "read_file",
                  callId: "c1",
                  input: {},
                },
              },
              {
                observation: {
                  kind: "tool-finished",
                  callId: "c1",
                  output: "ok",
                  isError: false,
                },
              },
              {
                observation: {
                  kind: "turn-ended",
                  turn: 1,
                  usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.02 },
                },
              },
              {
                observation: {
                  kind: "session-ended",
                  reason: { kind: "ended-by-user" },
                },
              },
            ],
          },
        ],
      }),
      "session.id",
    );

    await endedSession(harness, session);
    const read = await harness.ok(`/sessions/${session}/timeline`);

    expect(list(read, "timeline.turns")).toHaveLength(1);
    expect(at(read, "timeline.turns.0.toolCalls.0.toolName")).toBe("read_file");
    expect(at(read, "timeline.costUsd")).toBe(0.02);
    // It works after the fact, which is the point: "the post-mortem for something
    // that failed overnight."
    expect(at(read, "end.kind")).toBe("ended-by-user");
  });
});
