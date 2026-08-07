import { expect, afterEach, describe, it } from "bun:test";
import type { RuntimeScript } from "../runtime/scripted.js";
import {
  at,
  boot,
  cleanupHarnesses,
  command,
  endedSession,
  list,
  repository,
  str,
  waitFor,
  type Harness,
} from "../testing/harness.js";

/**
 * Scoped runs and the queue of work (§4.1, Epic 5.5).
 *
 * Four claims from §4.1 are what these tests are for, and each one is a rule the
 * product would otherwise only look like it kept:
 *
 * - a scoped run **previews exactly what it will execute** and accepts a cap;
 * - initiation beyond the concurrency limit **queues**, visibly and cancellably —
 *   "queuing is admission of already-initiated work, not scheduling";
 * - **the preview is the contract**: a queued run whose inputs drifted while it
 *   waited does not run, it re-asks;
 * - a batch **pauses** on a failed session and a stop **aborts** the remainder.
 */
afterEach(cleanupHarnesses);

/** Stays live, holding a concurrency slot until something stops it. */
const staysOpen: RuntimeScript = {
  acts: [
    {
      on: "start",
      steps: [
        { observation: { kind: "turn-started", turn: 1 } },
        {
          observation: {
            kind: "turn-ended",
            turn: 1,
            usage: { inputTokens: 5, outputTokens: 1 },
          },
        },
      ],
    },
  ],
};

const failsImmediately: RuntimeScript = {
  acts: [
    {
      on: "start",
      steps: [
        { observation: { kind: "turn-started", turn: 1 } },
        {
          observation: {
            kind: "session-ended",
            reason: { kind: "failed", message: "the tool exploded" },
          },
        },
      ],
    },
  ],
};

async function scope(
  harness: Harness,
  input: {
    readonly scope: string;
    readonly scopeId?: string | null;
    readonly initiationKey: string;
    readonly spendCapMicros?: number;
    readonly actor?: string;
  },
) {
  return harness.ok("/run-scopes", {
    method: "POST",
    body: {
      scope: input.scope,
      scopeId: input.scopeId ?? null,
      initiationKey: input.initiationKey,
      ...(input.spendCapMicros === undefined
        ? {}
        : { spendCapMicros: input.spendCapMicros }),
    },
    ...(input.actor === undefined ? {} : { actor: input.actor }),
  });
}

/**
 * The scripted runtime replays a script per launch, and a queued run enters the
 * ordinary run path without one — so a default script is configured instead, and
 * every session in these tests replays it.
 */
async function bootWithScript(
  script: RuntimeScript,
  concurrencyLimit = 1,
): Promise<Harness> {
  const { writeFileSync } = await import("node:fs");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "plotroom-script-"));
  const path = join(dir, "script.json");
  writeFileSync(path, JSON.stringify(script), "utf8");

  return boot({
    ...repository(),
    concurrencyLimit,
    runtime: { adapterId: "scripted", scriptPath: path },
  });
}

describe("the scoped preview is the contract (§4.1)", () => {
  it("names exactly the commands a subgraph would run, in dependency order", async () => {
    const harness = await bootWithScript(staysOpen);
    const first = await command(harness, { name: "Produce" });

    // A second command downstream of the first, wired to its output placeholder:
    // the dependency relation is read off the graph, never declared.
    const outputs = list(
      await harness.ok(`/commands/${first.commandId}`),
      "outputs",
    );
    const placeholder = str(outputs[0], "id");
    const second = await command(harness, {
      workstreamId: first.workstream,
      name: "Consume",
    });
    const placeholderNode = await harness.ok("/nodes", {
      method: "POST",
      body: {
        role: "content",
        refId: placeholder,
        workstreamId: first.workstream,
      },
    });
    await harness.ok("/edges", {
      method: "POST",
      body: {
        from: str(placeholderNode, "node.id"),
        to: second.commandNodeId,
      },
    });

    const preview = await harness.ok(
      `/run-scopes/preview?scope=subgraph&scopeId=${first.commandId}`,
    );

    const commands = list(preview, "commands");
    expect(commands.map((entry) => at(entry, "commandId"))).toEqual([
      first.commandId,
      second.commandId,
    ]);

    // The downstream command is blocked on its unproduced input, and the preview
    // says so rather than hiding it — the affordance never disables (§4.1).
    const blocked = list(preview, "blocked");
    expect(blocked.map((entry) => at(entry, "commandId"))).toEqual([
      second.commandId,
    ]);
    expect(String(at(blocked[0], "waitingOn.0"))).toContain("blocked on");
    expect(at(blocked[0], "unblockWith")).toBe("missing");

    // Nothing has ever been priced, so there is no range at all — not a zero.
    expect(at(preview, "estimate.range")).toBeNull();
    expect(at(preview, "spendCap.suggestedMicros")).toBeNull();

    // And it says how much of the scope would start now against the limit.
    expect(at(preview, "concurrency.limit")).toBe(1);
    expect(at(preview, "concurrency.startsNow")).toBe(1);
    expect(at(preview, "concurrency.queues")).toBe(1);
  });

  it("offers the upstream chain that would unblock a blocked command, asked once", async () => {
    const harness = await bootWithScript(staysOpen);
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

    // "Run what's missing" over the blocked command: the upstream chain first,
    // the command itself last, and one confirmation covers the chain.
    const preview = await harness.ok(
      `/run-scopes/preview?scope=missing&scopeId=${consumer.commandId}`,
    );
    const commands = list(preview, "commands");
    expect(commands.map((entry) => at(entry, "commandId"))).toEqual([
      producer.commandId,
      consumer.commandId,
    ]);
    expect(String(at(commands[0], "reason"))).toContain("unblocks");
  });
});

describe("the concurrency limit (§4.1)", () => {
  it("queues what does not fit, visibly, with a position, and cancellably", async () => {
    const harness = await bootWithScript(staysOpen, 1);
    const workstream = str(
      await harness.ok("/workstreams", { method: "POST", body: {} }),
      "workstream.id",
    );
    const first = await command(harness, {
      workstreamId: workstream,
      name: "A",
    });
    const second = await command(harness, {
      workstreamId: workstream,
      name: "B",
    });

    // Two independent commands, one scope each... but a fleet-wide gesture is the
    // interesting one: `drifted-*` needs drift, so a subgraph over each is used
    // and the limit is what makes the second wait.
    await scope(harness, {
      scope: "one",
      scopeId: first.commandId,
      initiationKey: "batch-a",
    });
    const batchB = await scope(harness, {
      scope: "one",
      scopeId: second.commandId,
      initiationKey: "batch-b",
    });

    // The second is admitted but waiting: the gesture already happened, and the
    // system is only deciding *when*.
    expect(at(batchB, "queued.0.state")).toBe("queued");

    const queue = await harness.ok("/run-queue");
    const waiting = list(queue, "queued").filter(
      (entry) => at(entry, "state") === "queued",
    );
    expect(waiting).toHaveLength(1);
    expect(at(waiting[0], "position")).toBe(1);

    // Cancellable before it starts.
    const cancelled = await harness.ok(`/run-queue/${str(waiting[0], "id")}`, {
      method: "DELETE",
    });
    expect(at(cancelled, "cancelled.state")).toBe("cancelled");

    // And refused afterwards: cancelling a started run is a stop (§6.7).
    const again = await harness.call(`/run-queue/${str(waiting[0], "id")}`, {
      method: "DELETE",
    });
    expect(again.status).toBe(409);
    expect(at(again.body, "error.details.reason")).toBe("already_started");
  });

  it("admits the next run when a slot frees, and nothing sooner", async () => {
    const harness = await bootWithScript(staysOpen, 1);
    const workstream = str(
      await harness.ok("/workstreams", { method: "POST", body: {} }),
      "workstream.id",
    );
    const first = await command(harness, {
      workstreamId: workstream,
      name: "A",
    });
    const second = await command(harness, {
      workstreamId: workstream,
      name: "B",
    });

    const batchA = await scope(harness, {
      scope: "one",
      scopeId: first.commandId,
      initiationKey: "batch-a",
    });
    await scope(harness, {
      scope: "one",
      scopeId: second.commandId,
      initiationKey: "batch-b",
    });

    const holder = str(batchA, "queued.0.sessionId");
    expect(holder).not.toBe("");

    // Stopping the first frees the slot. A stop, not an end: a producing session
    // ends on proven completion and refuses to be "ended" (§3.5), and stopping it
    // aborts *its own* batch only — what is queued behind it was initiated by
    // somebody else's gesture and is still admitted.
    await harness.ok(`/sessions/${holder}/stop`, { method: "POST", body: {} });

    const admitted = await waitFor(async () => {
      const queue = await harness.ok("/run-queue");
      const entry = list(queue, "queued").find(
        (candidate) => at(candidate, "commandId") === second.commandId,
      );
      return at(entry, "state") === "running" ? entry : null;
    }, "the queued run to be admitted once a slot freed");

    expect(at(admitted, "sessionId")).not.toBeNull();
  });

  it("admits what was waiting the moment the operator raises the limit, with no session event to wait for", async () => {
    const harness = await bootWithScript(staysOpen, 1);
    const workstream = str(
      await harness.ok("/workstreams", { method: "POST", body: {} }),
      "workstream.id",
    );
    const holder = await command(harness, {
      workstreamId: workstream,
      name: "Holder",
    });
    const waiter = await command(harness, {
      workstreamId: workstream,
      name: "Waiter",
    });

    await scope(harness, {
      scope: "one",
      scopeId: holder.commandId,
      initiationKey: "raise-holder",
    });
    const waiting = await scope(harness, {
      scope: "one",
      scopeId: waiter.commandId,
      initiationKey: "raise-waiter",
    });
    expect(at(waiting, "queued.0.state")).toBe("queued");

    // The raise is the only thing that happens: the holder is still running, so
    // nothing frees a slot, and nothing publishes a session event the queue
    // could drain from. Before this, the operator's raise did nothing visible
    // until the next session event — on an idle fleet, never.
    await harness.ok("/settings/concurrencyLimit", {
      method: "PUT",
      body: { value: 2 },
    });

    const admitted = await waitFor(async () => {
      const entry = list(await harness.ok("/run-queue"), "queued").find(
        (candidate) => at(candidate, "commandId") === waiter.commandId,
      );
      return at(entry, "state") === "running" ? entry : null;
    }, "the queued run to be admitted once the limit rose");

    expect(at(admitted, "sessionId")).not.toBeNull();
  });
});

describe("the preview is the contract (§4.1)", () => {
  it("re-asks instead of running when inputs drifted while it waited", async () => {
    const harness = await bootWithScript(staysOpen, 1);
    const workstream = str(
      await harness.ok("/workstreams", { method: "POST", body: {} }),
      "workstream.id",
    );
    const holderCommand = await command(harness, {
      workstreamId: workstream,
      name: "Holder",
    });
    const waitingCommand = await command(harness, {
      workstreamId: workstream,
      name: "Waiting",
      notes: [{ title: "The ticket", body: "as it was when you asked" }],
    });

    const holder = await scope(harness, {
      scope: "one",
      scopeId: holderCommand.commandId,
      initiationKey: "holder",
    });
    await scope(harness, {
      scope: "one",
      scopeId: waitingCommand.commandId,
      initiationKey: "waiter",
    });

    // While it waits, its input changes. Nothing about the queue changes yet: drift
    // is a state, not an action (§4.5).
    await harness.ok(`/notes/${waitingCommand.noteIds[0] as string}`, {
      method: "PATCH",
      body: { body: "rewritten while the run was queued" },
    });

    // Freeing the slot is where the contract is checked.
    await harness.ok(`/sessions/${str(holder, "queued.0.sessionId")}/stop`, {
      method: "POST",
      body: {},
    });

    const reasking = await waitFor(async () => {
      const queue = await harness.ok("/run-queue");
      const entry = list(queue, "queued").find(
        (candidate) => at(candidate, "commandId") === waitingCommand.commandId,
      );
      return at(entry, "state") === "needs_reask" ? entry : null;
    }, "the queued run to re-ask rather than run");

    // It did not run: no session, no run, and a message naming what changed.
    expect(at(reasking, "sessionId")).toBeNull();
    expect(at(reasking, "runId")).toBeNull();
    expect(String(at(reasking, "detail"))).toContain("changed since");

    // The slot really is free — the re-ask is not a run holding one.
    const sessions = list(await harness.ok("/sessions"), "sessions");
    expect(
      sessions.filter((session) => at(session, "session.end") === null),
    ).toHaveLength(0);

    // Confirming accepts what it would assemble *now*, and only then does it run.
    const confirmed = await harness.ok(
      `/run-queue/${str(reasking, "id")}/confirm`,
      { method: "POST", body: {} },
    );
    expect(at(confirmed, "confirmed.state")).toBe("running");
    expect(at(confirmed, "confirmed.sessionId")).not.toBeNull();

    // And it ran the new content, which is the only thing anyone agreed to.
    const runId = str(confirmed, "confirmed.runId");
    const assembled = await harness.ok(`/runs/${runId}/assembled`);
    expect(String(at(assembled, "content"))).toContain(
      "rewritten while the run was queued",
    );
  });

  it("refuses to confirm a run that is not asking", async () => {
    const harness = await bootWithScript(staysOpen, 1);
    const fixture = await command(harness, { name: "A" });
    const batch = await scope(harness, {
      scope: "one",
      scopeId: fixture.commandId,
      initiationKey: "batch-a",
    });

    const refused = await harness.call(
      `/run-queue/${str(batch, "queued.0.id")}/confirm`,
      { method: "POST", body: {} },
    );
    expect(refused.status).toBe(409);
    expect(at(refused.body, "error.details.reason")).toBe("not_reasking");
  });
});

describe("a batch pauses and aborts (§4.1)", () => {
  it("pauses the remainder on a failed session, and resumes on the human's word", async () => {
    const harness = await bootWithScript(failsImmediately, 1);
    const workstream = str(
      await harness.ok("/workstreams", { method: "POST", body: {} }),
      "workstream.id",
    );
    const producer = await command(harness, {
      workstreamId: workstream,
      name: "Produce",
    });
    const outputs = list(
      await harness.ok(`/commands/${producer.commandId}`),
      "outputs",
    );
    const consumer = await command(harness, {
      workstreamId: workstream,
      name: "Consume",
    });
    const placeholderNode = await harness.ok("/nodes", {
      method: "POST",
      body: {
        role: "content",
        refId: str(outputs[0], "id"),
        workstreamId: workstream,
      },
    });
    await harness.ok("/edges", {
      method: "POST",
      body: {
        from: str(placeholderNode, "node.id"),
        to: consumer.commandNodeId,
      },
    });

    const batch = await scope(harness, {
      scope: "subgraph",
      scopeId: producer.commandId,
      initiationKey: "subgraph-1",
    });
    const batchId = str(batch, "batch.id");

    const paused = await waitFor(async () => {
      const queue = await harness.ok("/run-queue");
      const found = list(queue, "batches").find(
        (candidate) => at(candidate, "id") === batchId,
      );
      return at(found, "state") === "paused" ? found : null;
    }, "the batch to pause on the failed session");

    // The pause always says why. Which reason wins is a race the product does not
    // need to resolve: the failing session pauses the batch, and so does the
    // downstream command being refused for the input that session never produced.
    // Both are §4.1's "address it and resume", and both leave the same state.
    expect(String(at(paused, "pauseReason")).length).toBeGreaterThan(0);

    // The failed run is recorded as failed rather than dropped (principle 11), and
    // is still readable: the open queue shows what can still happen, the batch read
    // shows what did.
    const entries = list(
      await harness.ok(`/run-batches/${batchId}`),
      "entries",
    );
    expect(
      entries.filter((entry) => at(entry, "state") === "failed"),
    ).not.toHaveLength(0);
    // Nothing in a paused batch is cancelled: paused is resumable, cancelled is not.
    expect(entries.some((entry) => at(entry, "state") === "cancelled")).toBe(
      false,
    );

    // Resuming is the human's gesture; the product never does it (principle 2).
    const resumed = await harness.ok(`/run-batches/${batchId}/resume`, {
      method: "POST",
      body: {},
    });
    expect(at(resumed, "batch.state")).not.toBe("paused");
  });

  it("aborts the remainder on a user stop, and never resumes it", async () => {
    const harness = await bootWithScript(staysOpen, 1);
    const workstream = str(
      await harness.ok("/workstreams", { method: "POST", body: {} }),
      "workstream.id",
    );
    const producer = await command(harness, {
      workstreamId: workstream,
      name: "Produce",
    });
    const outputs = list(
      await harness.ok(`/commands/${producer.commandId}`),
      "outputs",
    );
    const consumer = await command(harness, {
      workstreamId: workstream,
      name: "Consume",
    });
    const placeholderNode = await harness.ok("/nodes", {
      method: "POST",
      body: {
        role: "content",
        refId: str(outputs[0], "id"),
        workstreamId: workstream,
      },
    });
    await harness.ok("/edges", {
      method: "POST",
      body: {
        from: str(placeholderNode, "node.id"),
        to: consumer.commandNodeId,
      },
    });

    const batch = await scope(harness, {
      scope: "subgraph",
      scopeId: producer.commandId,
      initiationKey: "subgraph-2",
    });
    const batchId = str(batch, "batch.id");
    const sessionId = str(batch, "queued.0.sessionId");

    await harness.ok(`/sessions/${sessionId}/stop`, {
      method: "POST",
      body: {},
    });
    await endedSession(harness, sessionId);

    const aborted = await waitFor(async () => {
      const queue = await harness.ok("/run-queue");
      const found = list(queue, "batches").find(
        (candidate) => at(candidate, "id") === batchId,
      );
      return at(found, "state") === "aborted" ? found : null;
    }, "the batch to abort on the user stop");

    expect(at(aborted, "state")).toBe("aborted");

    // Stopped means stopped: an aborted batch is refused a resume.
    const resume = await harness.call(`/run-batches/${batchId}/resume`, {
      method: "POST",
      body: {},
    });
    expect(resume.status).toBe(409);
    expect(at(resume.body, "error.details.reason")).toBe("not_paused");
  });
});

describe("a confirmation cannot wedge the queue", () => {
  it("refuses a confirmation into an aborted batch — stopped means stopped", async () => {
    const harness = await bootWithScript(staysOpen, 1);
    const workstream = str(
      await harness.ok("/workstreams", { method: "POST", body: {} }),
      "workstream.id",
    );
    const producer = await command(harness, {
      workstreamId: workstream,
      name: "Produce",
    });
    const outputs = list(
      await harness.ok(`/commands/${producer.commandId}`),
      "outputs",
    );
    const consumer = await command(harness, {
      workstreamId: workstream,
      name: "Consume",
      notes: [{ title: "Brief", body: "as written" }],
    });
    const placeholderNode = await harness.ok("/nodes", {
      method: "POST",
      body: {
        role: "content",
        refId: str(outputs[0], "id"),
        workstreamId: workstream,
      },
    });
    await harness.ok("/edges", {
      method: "POST",
      body: {
        from: str(placeholderNode, "node.id"),
        to: consumer.commandNodeId,
      },
    });

    const batch = await scope(harness, {
      scope: "subgraph",
      scopeId: producer.commandId,
      initiationKey: "abort-then-confirm",
    });
    const batchId = str(batch, "batch.id");

    await harness.ok(`/sessions/${str(batch, "queued.0.sessionId")}/stop`, {
      method: "POST",
      body: {},
    });

    const aborted = await waitFor(async () => {
      const found = list(await harness.ok("/run-queue"), "batches").find(
        (candidate) => at(candidate, "id") === batchId,
      );
      return at(found, "state") === "aborted" ? found : null;
    }, "the batch to abort on the stop");
    expect(at(aborted, "state")).toBe("aborted");

    // Everything in it is cancelled, so there is nothing in `needs_reask` to
    // confirm — and asking about a cancelled entry says so rather than hanging.
    const entries = list(
      await harness.ok(`/run-batches/${batchId}`),
      "entries",
    );
    const cancelled = entries.find(
      (entry) => at(entry, "commandId") === consumer.commandId,
    );
    expect(at(cancelled, "state")).toBe("cancelled");

    const refused = await harness.call(
      `/run-queue/${String(at(cancelled, "id"))}/confirm`,
      { method: "POST", body: {} },
    );
    expect(refused.status).toBe(409);
    expect(at(refused.body, "error.details.reason")).toBe("not_reasking");
  });
});

describe("re-run all drifted (§4.1)", () => {
  it("runs nothing when nothing has drifted, and says so", async () => {
    const harness = await bootWithScript(staysOpen, 2);
    const fixture = await command(harness, {
      name: "A",
      notes: [{ title: "Ticket", body: "as written" }],
    });

    const empty = await harness.call("/run-scopes", {
      method: "POST",
      body: {
        scope: "drifted-workstream",
        scopeId: fixture.workstream,
        initiationKey: "drifted-1",
      },
    });

    expect(empty.status).toBe(409);
    expect(at(empty.body, "error.details.reason")).toBe("empty_scope");
  });

  it("covers exactly the commands whose inputs changed since they ran", async () => {
    const harness = await bootWithScript(staysOpen, 2);
    const workstream = str(
      await harness.ok("/workstreams", { method: "POST", body: {} }),
      "workstream.id",
    );
    const drifting = await command(harness, {
      workstreamId: workstream,
      name: "Drifts",
      notes: [{ title: "Ticket", body: "as written" }],
    });
    const untouched = await command(harness, {
      workstreamId: workstream,
      name: "Untouched",
      notes: [{ title: "Other", body: "unchanged" }],
    });

    // Both run once, so both have consumption to compare against.
    const one = await scope(harness, {
      scope: "one",
      scopeId: drifting.commandId,
      initiationKey: "first-a",
    });
    const two = await scope(harness, {
      scope: "one",
      scopeId: untouched.commandId,
      initiationKey: "first-b",
    });
    for (const batch of [one, two]) {
      await harness.ok(`/sessions/${str(batch, "queued.0.sessionId")}/stop`, {
        method: "POST",
        body: {},
      });
    }

    // One input changes. That is drift: a state, arriving because the world moved,
    // with nothing run and nothing scheduled.
    await harness.ok(`/notes/${drifting.noteIds[0] as string}`, {
      method: "PATCH",
      body: { body: "the review landed overnight" },
    });

    const preview = await harness.ok(
      `/run-scopes/preview?scope=drifted-workstream&scopeId=${workstream}`,
    );
    const commands = list(preview, "commands");

    // Exactly the drifted one. Never anything that is not drifted.
    expect(commands.map((entry) => at(entry, "commandId"))).toEqual([
      drifting.commandId,
    ]);
    expect(String(at(commands[0], "reason"))).toContain("drifted");

    // Fleet-wide is the same derivation over the whole board.
    const fleet = await harness.ok("/run-scopes/preview?scope=drifted-fleet");
    expect(
      list(fleet, "commands").map((entry) => at(entry, "commandId")),
    ).toEqual([drifting.commandId]);

    // And running it is one gesture over that one command.
    const ran = await scope(harness, {
      scope: "drifted-workstream",
      scopeId: workstream,
      initiationKey: "drifted-run",
    });
    expect(list(ran, "queued")).toHaveLength(1);
    expect(at(ran, "queued.0.commandId")).toBe(drifting.commandId);
  });
});

describe("the limit bounds initiation, not one endpoint (§4.1)", () => {
  it("answers POST /api/runs with 202 and a queued run when no slot is free", async () => {
    const harness = await bootWithScript(staysOpen, 1);
    const workstream = str(
      await harness.ok("/workstreams", { method: "POST", body: {} }),
      "workstream.id",
    );
    const first = await command(harness, {
      workstreamId: workstream,
      name: "A",
    });
    const second = await command(harness, {
      workstreamId: workstream,
      name: "B",
    });

    // The single-command endpoint, twice, with the limit at one. The second is
    // admitted rather than refused: the gesture already happened, and the system
    // is only deciding when.
    const started = await harness.call("/runs", {
      method: "POST",
      body: {
        commandId: first.commandId,
        initiationKey: "direct-1",
        runtime: { script: staysOpen },
      },
    });
    expect(started.status).toBe(201);

    const admitted = await harness.call("/runs", {
      method: "POST",
      body: {
        commandId: second.commandId,
        initiationKey: "direct-2",
        runtime: { script: staysOpen },
      },
    });

    expect(admitted.status).toBe(202);
    expect(at(admitted.body, "run")).toBeNull();
    expect(at(admitted.body, "session")).toBeNull();
    expect(at(admitted.body, "queued.state")).toBe("queued");
    expect(String(at(admitted.body, "queued.detail"))).toContain("slot");

    // Visible in the same queue as a scoped run, and cancellable there.
    const queued = list(await harness.ok("/run-queue"), "queued").filter(
      (entry) => at(entry, "state") === "queued",
    );
    expect(queued).toHaveLength(1);
    expect(at(queued[0], "commandId")).toBe(second.commandId);

    // The same gesture again is the same gesture, on this side of the limit too.
    const again = await harness.call("/runs", {
      method: "POST",
      body: {
        commandId: second.commandId,
        initiationKey: "direct-2",
        runtime: { script: staysOpen },
      },
    });
    expect(again.status).toBe(202);
    expect(at(again.body, "queued.id")).toBe(str(admitted.body, "queued.id"));

    // And it starts when a slot frees, under the key the caller used.
    await harness.ok(`/sessions/${str(started.body, "session.id")}/stop`, {
      method: "POST",
      body: {},
    });
    const running = await waitFor(async () => {
      const entry = list(await harness.ok("/run-queue"), "queued").find(
        (candidate) => at(candidate, "commandId") === second.commandId,
      );
      return at(entry, "state") === "running" ? entry : null;
    }, "the directly-initiated run to start once a slot freed");
    expect(at(running, "sessionId")).not.toBeNull();
  });

  it("keeps the ordinary one-session case a plain 201 under the default limit", async () => {
    // The W10 milestone gate runs one session under the shipped default, so the
    // familiar shape has to stay the familiar shape.
    const harness = await bootWithScript(staysOpen, 4);
    const fixture = await command(harness, { name: "A" });

    const started = await harness.call("/runs", {
      method: "POST",
      body: {
        commandId: fixture.commandId,
        initiationKey: "plain-1",
        runtime: { script: staysOpen },
      },
    });

    expect(started.status).toBe(201);
    expect(at(started.body, "queued")).toBeNull();
    expect(at(started.body, "session.id")).toBeTruthy();
  });
});

describe("shutdown closes the admission door (issue #71)", () => {
  it("refuses POST /api/runs once the queue has stopped, rather than starting a session", async () => {
    const harness = await bootWithScript(staysOpen, 4);
    const fixture = await command(harness, { name: "A" });

    harness.handle.queue.stopQueue();

    const refused = await harness.call("/runs", {
      method: "POST",
      body: {
        commandId: fixture.commandId,
        initiationKey: "post-shutdown-1",
        runtime: { script: staysOpen },
      },
    });

    expect(refused.status).toBe(409);
    expect(String(at(refused.body, "error.message"))).toMatch(/shutting down/);

    // Nothing was admitted: no session exists for this gesture, and a later
    // reconciliation cannot find one either.
    expect(list(await harness.ok("/run-queue"), "queued")).toHaveLength(0);
  });
});

describe("a restart does not strand admitted work (§4.1, principle 11)", () => {
  /**
   * Two things the queue owes a restart, and it owed neither before this:
   *
   * - an entry it believes is `running` has a session whose outcome nothing
   *   applied, because the process that would have heard it died. Left alone the
   *   batch stays `running` for ever and the operator is shown work in flight that
   *   nothing is doing (principle 11);
   * - an entry that was *waiting* was already initiated by somebody's gesture,
   *   which a restart does not un-initiate. Admitting it is §4.1's "the system is
   *   only deciding *when*, never *whether*" — not a timer, and not the product
   *   starting work of its own.
   */
  it("admits work that was queued when the process died", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const stateDir = mkdtempSync(join(tmpdir(), "plotroom-restart-"));
    mkdirSync(join(stateDir, "workspaces"), { recursive: true });
    const scriptPath = join(stateDir, "script.json");
    writeFileSync(scriptPath, JSON.stringify(staysOpen), "utf8");

    const settings = {
      ...repository(),
      concurrencyLimit: 1,
      runtime: { adapterId: "scripted", scriptPath },
    };

    const first = await boot(settings, { stateDir });
    const workstream = str(
      await first.ok("/workstreams", { method: "POST", body: {} }),
      "workstream.id",
    );
    const holder = await command(first, {
      workstreamId: workstream,
      name: "Holder",
    });
    const queuedCommand = await command(first, {
      workstreamId: workstream,
      name: "Queued",
    });

    await scope(first, {
      scope: "one",
      scopeId: holder.commandId,
      initiationKey: "restart-holder",
    });
    const waiting = await scope(first, {
      scope: "one",
      scopeId: queuedCommand.commandId,
      initiationKey: "restart-waiter",
    });
    expect(at(waiting, "queued.0.state")).toBe("queued");

    // The process goes away. Its live session is recorded as interrupted, and the
    // entry that was waiting for a slot is still waiting.
    await first.handle.close();

    const second = await boot(settings, { stateDir });

    // One boot-time drain, and the work somebody asked for is running. Nothing here
    // was decided by the product: the gesture happened before the restart.
    const admitted = await waitFor(async () => {
      const entry = list(await second.ok("/run-queue"), "queued").find(
        (candidate) => at(candidate, "commandId") === queuedCommand.commandId,
      );
      return at(entry, "state") === "running" ? entry : null;
    }, "the queued run to be admitted after the restart");

    expect(at(admitted, "sessionId")).not.toBeNull();
  });

  it("lets the operator finish a one-run batch the restart interrupted", async () => {
    // The narrowest version of the same shape, and the one that made resuming the
    // remedy into the disease: a batch of one whose run was interrupted has nothing
    // left to do, and resuming it — the gesture the pause instructs — used to put it
    // back to "running" for ever with nothing running.
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const stateDir = mkdtempSync(join(tmpdir(), "plotroom-restart-"));
    mkdirSync(join(stateDir, "workspaces"), { recursive: true });
    const scriptPath = join(stateDir, "script.json");
    writeFileSync(scriptPath, JSON.stringify(staysOpen), "utf8");

    const settings = {
      ...repository(),
      concurrencyLimit: 1,
      runtime: { adapterId: "scripted", scriptPath },
    };

    const first = await boot(settings, { stateDir });
    const only = await command(first, { name: "The only one" });
    const batch = await scope(first, {
      scope: "one",
      scopeId: only.commandId,
      initiationKey: "restart-single",
    });
    const batchId = str(batch, "batch.id");
    expect(at(batch, "queued.0.state")).toBe("running");

    await first.handle.close();
    const second = await boot(settings, { stateDir });

    const paused = await waitFor(async () => {
      const read = await second.ok(`/run-batches/${batchId}`);
      return at(read, "batch.state") === "paused" ? read : null;
    }, "the one-run batch to pause after the restart");
    expect(at(paused, "entries.0.state")).toBe("interrupted");

    // The gesture the pause asks for. It must finish the batch rather than reopen it.
    const resumed = await second.ok(`/run-batches/${batchId}/resume`, {
      method: "POST",
      body: {},
    });

    expect(at(resumed, "batch.state")).toBe("completed");
    expect(at(resumed, "batch.settledAt")).not.toBeNull();

    // And nothing was started to get there: the interrupted run is not silently
    // re-run by the resume (principle 2 — resuming an interrupted session is its own
    // gesture, and this is not it).
    const entries = list(await second.ok(`/run-batches/${batchId}`), "entries");
    expect(entries).toHaveLength(1);
    expect(at(entries[0], "state")).toBe("interrupted");
  });

  it("settles an interrupted run as interrupted, and pauses its batch honestly", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const stateDir = mkdtempSync(join(tmpdir(), "plotroom-restart-"));
    mkdirSync(join(stateDir, "workspaces"), { recursive: true });
    const scriptPath = join(stateDir, "script.json");
    writeFileSync(scriptPath, JSON.stringify(staysOpen), "utf8");

    const settings = {
      ...repository(),
      concurrencyLimit: 1,
      runtime: { adapterId: "scripted", scriptPath },
    };

    const first = await boot(settings, { stateDir });
    const workstream = str(
      await first.ok("/workstreams", { method: "POST", body: {} }),
      "workstream.id",
    );
    const producer = await command(first, {
      workstreamId: workstream,
      name: "Produce",
    });
    const outputs = list(
      await first.ok(`/commands/${producer.commandId}`),
      "outputs",
    );
    const consumer = await command(first, {
      workstreamId: workstream,
      name: "Consume",
    });
    const placeholderNode = await first.ok("/nodes", {
      method: "POST",
      body: {
        role: "content",
        refId: str(outputs[0], "id"),
        workstreamId: workstream,
      },
    });
    await first.ok("/edges", {
      method: "POST",
      body: {
        from: str(placeholderNode, "node.id"),
        to: consumer.commandNodeId,
      },
    });

    const batch = await scope(first, {
      scope: "subgraph",
      scopeId: producer.commandId,
      initiationKey: "restart-subgraph",
    });
    const batchId = str(batch, "batch.id");
    expect(at(batch, "queued.0.state")).toBe("running");

    await first.handle.close();
    const second = await boot(settings, { stateDir });

    const read = await waitFor(async () => {
      const found = await second.ok(`/run-batches/${batchId}`);
      return at(found, "batch.state") === "running" ? null : found;
    }, "the interrupted batch to be reconciled");

    const entries = list(read, "entries");
    const producerEntry = entries.find(
      (entry) => at(entry, "commandId") === producer.commandId,
    );

    // **Interrupted, not done.** Nobody stopped it, it did not fail, and it did not
    // finish — the distinction the session and the run already keep (principle 11),
    // now kept by the queue too. Recording it as `done` was the old behaviour and it
    // reported success for work that never happened.
    expect(at(producerEntry, "state")).toBe("interrupted");
    expect(at(producerEntry, "settledAt")).not.toBeNull();

    // The batch says so rather than sitting at "running" for ever with nothing
    // running: paused, which is §4.1's "address it and resume".
    expect(at(read, "batch.state")).toBe("paused");
    expect(String(at(read, "batch.pauseReason"))).toContain("interrupted");

    // The session it came from agrees, so the two records tell one story.
    const session = await second.ok(
      `/sessions/${String(at(producerEntry, "sessionId"))}`,
    );
    expect(at(session, "session.end.kind")).toBe("interrupted");
  });
});

describe("the in-batch rule: a chain runs unattended (§4.1)", () => {
  /**
   * The rule under test, which is a *decision* about what "the preview is the
   * contract" means for a chain:
   *
   * A subgraph is one gesture over commands the operator previewed **as a chain** —
   * they were shown that the downstream command consumes the upstream command's
   * output. So when the upstream runs and binds that output, the downstream's input
   * appearing is the contract **executing**, not the contract drifting. Re-asking
   * there would ask the operator to confirm what they just confirmed, and a batch
   * of two could never finish without a human answering a question about its own
   * middle. Inputs produced inside the same batch are therefore excluded from that
   * entry's contract hash, along with the `runnable` flip they cause.
   *
   * Drift from **outside** the batch is untouched by this, which the second test
   * here is for.
   */
  it("runs a two-step subgraph to completion with nobody answering anything", async () => {
    // The produced object is seeded before the server boots, so the shared script
    // can name it: what makes this test deterministic is that the upstream really
    // binds its placeholder, which is what unblocks the downstream.
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { openDatabase, ObjectStore } = await import("@plotroom/db");

    const stateDir = mkdtempSync(join(tmpdir(), "plotroom-chain-"));
    const seed = openDatabase({ stateDir });
    const produced = new ObjectStore(seed).write({
      kind: "document",
      title: "The result",
      renderings: {
        card: { text: "produced" },
        summary: "produced",
        agentContent: "the upstream command's result",
      },
    });
    seed.close();

    const submits: RuntimeScript = {
      acts: [
        {
          on: "start",
          steps: [
            { observation: { kind: "turn-started", turn: 1 } },
            {
              submit: {
                outputs: [
                  {
                    name: "result",
                    objectId: produced.objectId,
                    versionId: produced.versionId,
                  },
                ],
              },
            },
            {
              observation: {
                kind: "turn-ended",
                turn: 1,
                usage: { inputTokens: 10, outputTokens: 3 },
              },
            },
          ],
        },
      ],
    };

    const scriptPath = join(stateDir, "script.json");
    writeFileSync(scriptPath, JSON.stringify(submits), "utf8");

    // Two slots, so it is the *chain* holding the downstream back rather than the
    // concurrency limit — the limit passing this test for the wrong reason is
    // exactly what an untested rule looks like.
    const harness = await boot(
      {
        ...repository(),
        concurrencyLimit: 2,
        runtime: { adapterId: "scripted", scriptPath },
      },
      { stateDir },
    );

    const workstream = str(
      await harness.ok("/workstreams", { method: "POST", body: {} }),
      "workstream.id",
    );
    const upstream = await command(harness, {
      workstreamId: workstream,
      name: "Produce",
    });
    const outputs = list(
      await harness.ok(`/commands/${upstream.commandId}`),
      "outputs",
    );
    const downstream = await command(harness, {
      workstreamId: workstream,
      name: "Consume",
    });
    const placeholderNode = await harness.ok("/nodes", {
      method: "POST",
      body: {
        role: "content",
        refId: str(outputs[0], "id"),
        workstreamId: workstream,
      },
    });
    await harness.ok("/edges", {
      method: "POST",
      body: {
        from: str(placeholderNode, "node.id"),
        to: downstream.commandNodeId,
      },
    });

    // The preview says so up front: the downstream is blocked *now*, and the batch
    // is what makes it runnable.
    const preview = await harness.ok(
      `/run-scopes/preview?scope=subgraph&scopeId=${upstream.commandId}`,
    );
    const previewed = list(preview, "commands");
    expect(previewed.map((entry) => at(entry, "commandId"))).toEqual([
      upstream.commandId,
      downstream.commandId,
    ]);
    expect(at(previewed[1], "satisfiedByBatch")).toBe(true);

    const batch = await scope(harness, {
      scope: "subgraph",
      scopeId: upstream.commandId,
      initiationKey: "unattended-chain",
    });
    const batchId = str(batch, "batch.id");

    // Nobody confirms anything from here on. The batch either finishes or it does
    // not, and before the in-batch rule it could not.
    const finished = await waitFor(async () => {
      const read = await harness.ok(`/run-batches/${batchId}`);
      return at(read, "batch.state") === "completed" ? read : null;
    }, "the two-step batch to complete unattended");

    const entries = list(finished, "entries");
    expect(entries.map((entry) => at(entry, "state"))).toEqual([
      "done",
      "done",
    ]);

    // Never asked. That is the assertion: a chain the operator confirmed as a chain
    // does not stop halfway to ask about its own middle.
    expect(
      entries.filter((entry) => at(entry, "state") === "needs_reask"),
    ).toHaveLength(0);

    // The downstream really consumed the upstream's output, so this proves the rule
    // rather than a batch that skipped the input entirely.
    const downstreamRun = str(entries[1], "runId");
    const assembled = await harness.ok(`/runs/${downstreamRun}/assembled`);
    expect(String(at(assembled, "content"))).toContain(
      "the upstream command's result",
    );

    // And the batch is done: nothing paused, nothing waiting, nothing asking.
    expect(at(finished, "batch.state")).toBe("completed");
    expect(list(await harness.ok("/run-queue"), "queued")).toHaveLength(0);
  });

  it("does not strand a downstream when its producer fails and the operator resumes", async () => {
    // The path a real operator takes: a producer fails, §4.1 pauses the batch and
    // tells them to address it and resume, and resuming must reach a conclusion. It
    // used to leave the downstream queued for ever — waiting on a command that was
    // never going to run again.
    const harness = await bootWithScript(failsImmediately, 1);
    const workstream = str(
      await harness.ok("/workstreams", { method: "POST", body: {} }),
      "workstream.id",
    );
    const producer = await command(harness, {
      workstreamId: workstream,
      name: "Produce",
    });
    const outputs = list(
      await harness.ok(`/commands/${producer.commandId}`),
      "outputs",
    );
    const consumer = await command(harness, {
      workstreamId: workstream,
      name: "Consume",
    });
    const placeholderNode = await harness.ok("/nodes", {
      method: "POST",
      body: {
        role: "content",
        refId: str(outputs[0], "id"),
        workstreamId: workstream,
      },
    });
    await harness.ok("/edges", {
      method: "POST",
      body: {
        from: str(placeholderNode, "node.id"),
        to: consumer.commandNodeId,
      },
    });

    const batch = await scope(harness, {
      scope: "subgraph",
      scopeId: producer.commandId,
      initiationKey: "producer-fails",
    });
    const batchId = str(batch, "batch.id");

    await waitFor(async () => {
      const read = await harness.ok(`/run-batches/${batchId}`);
      return at(read, "batch.state") === "paused" ? read : null;
    }, "the batch to pause on the failed producer");

    const resumed = await harness.ok(`/run-batches/${batchId}/resume`, {
      method: "POST",
      body: {},
    });

    // A conclusion, either way — never a queue entry nobody will ever admit.
    expect(at(resumed, "batch.state")).toBe("completed");

    const entries = list(
      await harness.ok(`/run-batches/${batchId}`),
      "entries",
    );
    const downstream = entries.find(
      (entry) => at(entry, "commandId") === consumer.commandId,
    );
    expect(at(downstream, "state")).toBe("cancelled");
    expect(String(at(downstream, "detail"))).toContain(
      "settled without producing",
    );
    expect(list(await harness.ok("/run-queue"), "queued")).toHaveLength(0);
  });

  it("still re-asks when an input from outside the batch drifts mid-queue", async () => {
    // The other half of the rule. Nothing about the in-batch exclusion loosens what
    // the contract covers: an input the batch does not produce is exactly as binding
    // as before.
    const harness = await bootWithScript(staysOpen, 1);
    const workstream = str(
      await harness.ok("/workstreams", { method: "POST", body: {} }),
      "workstream.id",
    );
    const holder = await command(harness, {
      workstreamId: workstream,
      name: "Holder",
    });
    const waiting = await command(harness, {
      workstreamId: workstream,
      name: "Waiting",
      notes: [{ title: "Brief", body: "as it was when you asked" }],
    });

    const first = await scope(harness, {
      scope: "one",
      scopeId: holder.commandId,
      initiationKey: "outside-holder",
    });
    await scope(harness, {
      scope: "one",
      scopeId: waiting.commandId,
      initiationKey: "outside-waiter",
    });

    // A note nothing in the batch produces. Changing it is drift, not execution.
    await harness.ok(`/notes/${waiting.noteIds[0] as string}`, {
      method: "PATCH",
      body: { body: "rewritten by somebody else while this waited" },
    });

    await harness.ok(`/sessions/${str(first, "queued.0.sessionId")}/stop`, {
      method: "POST",
      body: {},
    });

    const reasking = await waitFor(async () => {
      const entry = list(await harness.ok("/run-queue"), "queued").find(
        (candidate) => at(candidate, "commandId") === waiting.commandId,
      );
      return at(entry, "state") === "needs_reask" ? entry : null;
    }, "the out-of-batch drift to re-ask");

    expect(at(reasking, "sessionId")).toBeNull();
    expect(String(at(reasking, "detail"))).toContain("changed since");
  });
});

describe("one gesture creates one batch (principle 9)", () => {
  it("answers a replayed initiation key with the same batch", async () => {
    const harness = await bootWithScript(staysOpen, 2);
    const fixture = await command(harness, { name: "A" });

    const first = await scope(harness, {
      scope: "one",
      scopeId: fixture.commandId,
      initiationKey: "one-gesture",
    });
    const again = await harness.call("/run-scopes", {
      method: "POST",
      body: {
        scope: "one",
        scopeId: fixture.commandId,
        initiationKey: "one-gesture",
      },
    });

    expect(again.status).toBe(200);
    expect(at(again.body, "replayed")).toBe(true);
    expect(at(again.body, "batch.id")).toBe(str(first, "batch.id"));
    expect(list(again.body, "queued")).toHaveLength(1);
  });
});
