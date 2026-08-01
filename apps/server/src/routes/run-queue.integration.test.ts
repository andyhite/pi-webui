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
