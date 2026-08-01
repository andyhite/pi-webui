import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  endStateFacts,
  humanAuthor,
  INHERIT_APP_TOOLS,
  type DomainEvent,
  type SessionEnd,
} from "@plotroom/core";
import { openDatabase, RunStore, SessionStore } from "@plotroom/db";
import { loadServerConfig, type ServerConfigOverrides } from "../config.js";
import { startServer } from "../index.js";
import type { RuntimeScript } from "../runtime/scripted.js";

/**
 * The run spine, over the real app (Epics 4.1/4.2).
 *
 * Every test here drives the HTTP API of a real server against a real SQLite
 * state directory and a real git repository, with the **scripted** runtime
 * selected. That runtime replays a declared script of observations and shares
 * every downstream line of code with the pi adapter — the observation log, the
 * phase reducer, accounting, the WS stream, the completion loop — so what these
 * tests prove about the spine is true of a real session too.
 */
let port = 46300;

interface Harness {
  readonly handle: ReturnType<typeof startServer>;
  readonly stateDir: string;
  readonly port: number;
  call(path: string, options?: CallOptions): Promise<CallResult>;
  ok(path: string, options?: CallOptions): Promise<unknown>;
}

interface CallOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly actor?: string;
}

interface CallResult {
  readonly status: number;
  readonly body: unknown;
}

const harnesses: Harness[] = [];
const scratch: string[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.handle.close();
  }
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A real repository to branch from: provisioning uses `git worktree`. */
function gitRepository(): string {
  const dir = mkdtempSync(join(tmpdir(), "plotroom-repo-"));
  scratch.push(dir);

  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });

  git("init", "--initial-branch", "main");
  git("config", "user.email", "test@plotroom.invalid");
  git("config", "user.name", "PlotRoom Test");
  writeFileSync(join(dir, "README.md"), "# fixture\n", "utf8");
  git("add", ".");
  git("commit", "-m", "initial");

  return dir;
}

async function boot(
  overrides: ServerConfigOverrides = {},
  options: { readonly stateDir?: string } = {},
): Promise<Harness> {
  port += 1;
  const stateDir =
    options.stateDir ?? mkdtempSync(join(tmpdir(), "plotroom-run-test-"));
  if (options.stateDir === undefined) scratch.push(stateDir);

  const workspaceDir = join(stateDir, "workspaces");
  mkdirSync(workspaceDir, { recursive: true });

  const thisPort = port;
  const handle = startServer(
    loadServerConfig(
      {},
      {
        host: "127.0.0.1",
        port: thisPort,
        stateDir,
        credential: null,
        allowNonLoopbackBind: false,
        trustedOrigins: [],
        staticDir: join(tmpdir(), "plotroom-no-such-renderer-dir"),
        logLevel: "error",
        ...overrides,
        runtime: { adapterId: "scripted", ...overrides.runtime },
        workspace: {
          kind: "git",
          directory: workspaceDir,
          ...overrides.workspace,
        },
      },
    ),
  );
  await handle.recovered;

  const base = `http://127.0.0.1:${thisPort}/api`;
  const origin = `http://localhost:${thisPort}`;

  const call = async (
    path: string,
    callOptions: CallOptions = {},
  ): Promise<CallResult> => {
    const res = await fetch(`${base}${path}`, {
      method: callOptions.method ?? "GET",
      headers: {
        origin,
        "content-type": "application/json",
        ...(callOptions.actor ? { "x-plotroom-actor": callOptions.actor } : {}),
      },
      ...(callOptions.body !== undefined
        ? { body: JSON.stringify(callOptions.body) }
        : {}),
    });
    return { status: res.status, body: await res.json() };
  };

  const harness: Harness = {
    handle,
    stateDir,
    port: thisPort,
    call,
    async ok(path, callOptions) {
      const res = await call(path, callOptions);
      if (res.status >= 300) {
        throw new Error(
          `${path} failed: ${res.status} ${JSON.stringify(res.body)}`,
        );
      }
      return res.body;
    },
  };

  harnesses.push(harness);
  return harness;
}

function at(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (current, key) => (current as Record<string, unknown>)?.[key],
      value,
    );
}

function str(value: unknown, path: string): string {
  const found = at(value, path);
  if (typeof found !== "string") {
    throw new Error(
      `expected a string at ${path}, got ${JSON.stringify(found)}`,
    );
  }
  return found;
}

function list(value: unknown, path: string): unknown[] {
  const found = at(value, path);
  if (!Array.isArray(found)) {
    throw new Error(
      `expected an array at ${path}, got ${JSON.stringify(found)}`,
    );
  }
  return found;
}

async function waitFor<T>(
  read: () => Promise<T | null>,
  what: string,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/* ------------------------------------------------------------------ fixtures */

interface CommandFixture {
  readonly workstream: string;
  readonly commandId: string;
  readonly noteIds: readonly string[];
}

interface DefineOptions {
  readonly conditions?: readonly {
    readonly id: string;
    readonly predicate: string;
    readonly description: string;
    readonly args?: Record<string, string>;
  }[];
  readonly budget?: {
    readonly modelWindowTokens: number;
    readonly warnAtFraction: number;
    readonly hardCapTokens: number | null;
  };
  readonly lifecycle?: "producing" | "open";
  readonly notes?: readonly { readonly title: string; readonly body: string }[];
}

/** A workstream with a producing command and its ordered context (§3.5). */
async function command(
  harness: Harness,
  options: DefineOptions = {},
): Promise<CommandFixture> {
  const workstream = str(
    await harness.ok("/workstreams", { method: "POST", body: {} }),
    "workstream.id",
  );

  const lifecycle = options.lifecycle ?? "producing";
  const definition = await harness.ok("/command-definitions", {
    method: "POST",
    body: {
      name: "Implement the ticket",
      instruction: "Implement it.",
      model: "fixture-model",
      effort: "medium",
      lifecycle,
      ...(lifecycle === "producing"
        ? {
            outcome: {
              name: "result",
              kind: "document",
              conditions: options.conditions ?? [],
            },
          }
        : {}),
      ...(options.budget ? { budget: options.budget } : {}),
    },
  });

  const instantiated = await harness.ok("/commands", {
    method: "POST",
    body: {
      definitionId: str(definition, "definition.id"),
      workstreamId: workstream,
    },
  });
  const commandNode = str(instantiated, "node.id");

  const noteIds: string[] = [];
  for (const note of options.notes ?? []) {
    const written = await harness.ok("/notes", {
      method: "POST",
      body: { ...note, workstreamId: workstream },
    });
    const objectId = str(written, "object.id");
    noteIds.push(objectId);

    const node = await harness.ok("/nodes", {
      method: "POST",
      body: { role: "content", refId: objectId, workstreamId: workstream },
    });
    await harness.ok("/edges", {
      method: "POST",
      body: { from: str(node, "node.id"), to: commandNode },
    });
  }

  return {
    workstream,
    commandId: str(instantiated, "command.id"),
    noteIds,
  };
}

const repository = (): ServerConfigOverrides => ({
  workspace: { repositoryPath: gitRepository() },
});

/** A script that streams a turn and then ends, the shortest complete session. */
const oneTurn: RuntimeScript = {
  acts: [
    {
      on: "start",
      steps: [
        { observation: { kind: "turn-started", turn: 1 } },
        {
          observation: { kind: "reasoning-delta", text: "reading the ticket" },
        },
        { observation: { kind: "output-delta", text: "here is " } },
        { observation: { kind: "output-delta", text: "the plan" } },
        {
          observation: {
            kind: "tool-started",
            toolName: "read_file",
            callId: "c1",
            input: { path: "README.md" },
          },
        },
        {
          observation: {
            kind: "tool-finished",
            callId: "c1",
            output: "# fixture",
            isError: false,
          },
        },
        {
          observation: {
            kind: "turn-ended",
            turn: 1,
            usage: { inputTokens: 120, outputTokens: 30, costUsd: 0.002 },
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
};

/** A script that never ends: the session stays in flight (principle 11). */
const neverEnds: RuntimeScript = {
  acts: [
    {
      on: "start",
      steps: [
        { observation: { kind: "turn-started", turn: 1 } },
        { observation: { kind: "output-delta", text: "still working" } },
      ],
    },
  ],
};

async function run(
  harness: Harness,
  commandId: string,
  script: RuntimeScript,
  initiationKey = `key-${Math.random().toString(36).slice(2)}`,
): Promise<unknown> {
  return harness.ok("/runs", {
    method: "POST",
    body: { commandId, initiationKey, runtime: { script } },
  });
}

async function endedSession(harness: Harness, sessionId: string) {
  return waitFor(async () => {
    const read = await harness.ok(`/sessions/${sessionId}`);
    return at(read, "session.end") === null ? null : read;
  }, `session ${sessionId} to end`);
}

/* --------------------------------------------------------------------- tests */

describe("idempotent initiation (principle 9)", () => {
  it("gives a retry the same run and the same session", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      notes: [{ title: "ticket", body: "do the thing" }],
    });

    const first = await run(harness, fixture.commandId, neverEnds, "gesture-1");
    const second = await harness.call("/runs", {
      method: "POST",
      body: {
        commandId: fixture.commandId,
        initiationKey: "gesture-1",
        runtime: { script: neverEnds },
      },
    });

    expect(second.status).toBe(200);
    expect(at(second.body, "replayed")).toBe(true);
    expect(str(second.body, "run.id")).toBe(str(first, "run.id"));
    expect(str(second.body, "session.id")).toBe(str(first, "session.id"));

    // A different gesture is a different run, and the ordinal says so (§15-4).
    const third = await run(harness, fixture.commandId, neverEnds, "gesture-2");
    expect(at(third, "run.ordinal")).toBe(2);
    expect(str(third, "run.id")).not.toBe(str(first, "run.id"));

    const history = await harness.ok(`/commands/${fixture.commandId}/runs`);
    expect(list(history, "runs").map((each) => at(each, "ordinal"))).toEqual([
      1, 2,
    ]);
  });

  it("refuses a key that already started a different command", async () => {
    const harness = await boot(repository());
    const first = await command(harness);
    const second = await command(harness);

    await run(harness, first.commandId, neverEnds, "shared-key");
    const res = await harness.call("/runs", {
      method: "POST",
      body: {
        commandId: second.commandId,
        initiationKey: "shared-key",
        runtime: { script: neverEnds },
      },
    });

    expect(res.status).toBe(409);
    expect(at(res.body, "error.details")).toEqual({
      reason: "initiation_key_reused",
    });
  });
});

describe("the runtime registry (decision 0001)", () => {
  it("has no scripted runtime to name unless the operator selected it", async () => {
    const harness = await boot({
      workspace: { repositoryPath: gitRepository() },
      // The default installation: adapter v1, and no script replay anywhere.
      runtime: { adapterId: "pi-coding-agent" },
    });
    const fixture = await command(harness);

    const res = await harness.call("/runs", {
      method: "POST",
      body: {
        commandId: fixture.commandId,
        initiationKey: "scripted-on-a-real-install",
        runtime: { adapterId: "scripted", script: oneTurn },
      },
    });

    expect(res.status).toBe(409);
    expect(at(res.body, "error.details")).toEqual({
      reason: "unknown_runtime",
    });
  });
});

describe("the readiness gate (§3.4)", () => {
  it("blocks the run with the reason visible, and records nothing", async () => {
    const harness = await boot({
      workspace: {
        repositoryPath: gitRepository(),
        setup: {
          program: "false",
          args: [],
          workingSubdirectory: "",
          label: "install dependencies",
        },
      },
    });
    const fixture = await command(harness);

    const res = await harness.call("/runs", {
      method: "POST",
      body: {
        commandId: fixture.commandId,
        initiationKey: "blocked",
        runtime: { script: oneTurn },
      },
    });

    expect(res.status).toBe(409);
    expect(at(res.body, "error.details")).toEqual({
      reason: "workspace_setup_failed",
    });
    expect(at(res.body, "error.message")).toMatch(
      /install dependencies failed/,
    );

    // Nothing ran, and the key is free again: a refusal is not a spent gesture.
    const history = await harness.ok(`/commands/${fixture.commandId}/runs`);
    expect(list(history, "runs")).toHaveLength(0);
  });

  it("refuses when no repository is configured to branch from", async () => {
    const harness = await boot({ workspace: { repositoryPath: null } });
    const fixture = await command(harness);

    const res = await harness.call("/runs", {
      method: "POST",
      body: {
        commandId: fixture.commandId,
        initiationKey: "unconfigured",
        runtime: { script: oneTurn },
      },
    });

    expect(res.status).toBe(409);
    expect(at(res.body, "error.details")).toEqual({
      reason: "workspace_not_configured",
    });
  });
});

describe("the run preview (§4.1)", () => {
  it("says exactly what will execute, and provisions nothing", async () => {
    // Deliberately no repository configured: a preview must not need one,
    // because it provisions nothing and starts nothing.
    const harness = await boot({ workspace: { repositoryPath: null } });
    const fixture = await command(harness, {
      notes: [
        { title: "first", body: "AAA the first input" },
        { title: "second", body: "BBB the second input" },
      ],
    });

    const preview = await harness.ok(`/commands/${fixture.commandId}/preview`);

    expect(at(preview, "preview.runnable")).toBe(true);
    expect(
      list(preview, "preview.inputs").map((input) => at(input, "ordinal")),
    ).toEqual([1, 2]);
    const bodyText = str(preview, "preview.body");
    expect(bodyText.indexOf("AAA")).toBeLessThan(bodyText.indexOf("BBB"));
    expect(at(preview, "preview.estimatedTokens")).toBeGreaterThan(0);
    expect(at(preview, "preview.nextOrdinal")).toBe(1);
    expect(at(preview, "preview.configuration.instruction")).toBe(
      "Implement it.",
    );
    // Every version that would be consumed is named, so "exactly what will
    // execute" includes which version of each input (§15-1).
    for (const input of list(preview, "preview.inputs")) {
      expect(typeof at(input, "versionId")).toBe("string");
      expect(at(input, "bytes")).toBeGreaterThan(0);
    }

    // It says a first run will have to provision, and that nothing is
    // configured to provision from — without doing either.
    expect(at(preview, "workspace.provisionsAtFirstRun")).toBe(true);
    expect(at(preview, "workspace.configured")).toBe(false);

    // Nothing was recorded and nothing was started.
    expect(
      list(await harness.ok(`/commands/${fixture.commandId}/runs`), "runs"),
    ).toHaveLength(0);
    expect(list(await harness.ok("/sessions"), "sessions")).toHaveLength(0);
    const inventory = await harness.ok("/maintenance/state");
    expect(at(inventory, "inventory.counts.runs")).toBe(0);
  });

  it("states its estimate's basis, and prices only from history", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      notes: [{ title: "ticket", body: "do the thing" }],
    });

    const before = await harness.ok(`/commands/${fixture.commandId}/preview`);
    expect(at(before, "preview.estimate.basis")).toBe("input-size-only");
    // No history means no number: null, not zero (§4.1, principle 7).
    expect(at(before, "preview.estimate.range")).toBeNull();
    expect(at(before, "preview.estimate.description")).toMatch(
      /no priced history/,
    );
    expect(at(before, "spendCap.suggestedMicros")).toBeNull();

    const started = await run(harness, fixture.commandId, oneTurn);
    await endedSession(harness, str(started, "session.id"));

    const after = await harness.ok(`/commands/${fixture.commandId}/preview`);
    // The scripted turn reported $0.002, so history now has one priced run.
    expect(at(after, "preview.estimate.basis")).toBe("prior-runs");
    expect(at(after, "preview.estimate.priorRuns")).toBe(1);
    expect(at(after, "preview.estimate.range.lowMicros")).toBe(2_000);
    expect(at(after, "preview.estimate.range.highMicros")).toBe(2_000);
    expect(at(after, "preview.estimate.description")).toMatch(
      /based on 1 prior run of this definition/,
    );
    // The cap the operator is offered is the most expensive prior run.
    expect(at(after, "spendCap.suggestedMicros")).toBe(2_000);
    expect(at(after, "spendCap.accepted")).toBeNull();
    expect(at(after, "preview.nextOrdinal")).toBe(2);
  });

  it("reports what blocks a run rather than refusing to say", async () => {
    const harness = await boot(repository());
    const definition = await harness.ok("/command-definitions", {
      method: "POST",
      body: {
        name: "Parameterised",
        instruction: "Do it in {repo}.",
        model: "fixture-model",
        effort: "medium",
        lifecycle: "open",
        parameters: [
          { name: "repo", label: "Repository", type: "text", required: true },
        ],
      },
    });
    const workstream = str(
      await harness.ok("/workstreams", { method: "POST", body: {} }),
      "workstream.id",
    );
    const instantiated = await harness.ok("/commands", {
      method: "POST",
      body: {
        definitionId: str(definition, "definition.id"),
        workstreamId: workstream,
      },
    });
    const commandId = str(instantiated, "command.id");

    const preview = await harness.ok(`/commands/${commandId}/preview`);

    expect(at(preview, "preview.runnable")).toBe(false);
    expect(at(preview, "preview.configuration")).toBeNull();
    expect(
      list(preview, "preview.blockers").map((one) => at(one, "reason")),
    ).toEqual(["parameters_unconfirmed"]);
    expect(str(list(preview, "preview.blockers")[0], "message")).toMatch(
      /confirm repo before running/,
    );

    // And the run refuses with exactly the reason the preview showed.
    const res = await harness.call("/runs", {
      method: "POST",
      body: {
        commandId,
        initiationKey: "blocked-by-parameter",
        runtime: { script: oneTurn },
      },
    });
    expect(res.status).toBe(409);
    expect(at(res.body, "error.details")).toEqual({
      reason: "parameters_unconfirmed",
    });
  });

  it("records the spend cap the operator accepted (§4.1, §8)", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness);

    const started = await harness.ok("/runs", {
      method: "POST",
      body: {
        commandId: fixture.commandId,
        initiationKey: "capped-gesture",
        spendCapMicros: 500_000,
        runtime: { script: oneTurn },
      },
    });

    expect(at(started, "run.spendCapMicros")).toBe(500_000);

    const read = await harness.ok(`/runs/${str(started, "run.id")}`);
    expect(at(read, "run.spendCapMicros")).toBe(500_000);

    // No cap accepted stays null rather than becoming a cap of zero.
    const uncapped = await run(harness, fixture.commandId, oneTurn);
    expect(at(uncapped, "run.spendCapMicros")).toBeNull();
  });
});

describe("assembly and run history (§3.5, §15-1, §15-4)", () => {
  it("assembles ordered content whole and records exactly what ran", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      notes: [
        { title: "first", body: "AAA the first input" },
        { title: "second", body: "BBB the second input" },
      ],
    });

    const started = await run(harness, fixture.commandId, oneTurn);
    const runId = str(started, "run.id");

    const assembled = await harness.ok(`/runs/${runId}/assembled`);
    const content = str(assembled, "content");
    expect(content).toContain("AAA the first input");
    expect(content).toContain("BBB the second input");
    // Order is the edge order, not the insertion order of anything else (§3.5).
    expect(content.indexOf("AAA")).toBeLessThan(content.indexOf("BBB"));

    const read = await harness.ok(`/runs/${runId}`);
    const inputs = list(read, "inputs");
    expect(inputs).toHaveLength(2);
    expect(inputs.map((input) => at(input, "ordinal"))).toEqual([1, 2]);
    // §15-1: the versions that went in are recorded, so the run stays
    // comparable however the objects change afterwards.
    for (const input of inputs) {
      expect(typeof at(input, "versionId")).toBe("string");
    }
    expect(at(read, "configuration.instruction")).toBe("Implement it.");
    expect(at(read, "configuration.model.model")).toBe("fixture-model");
  });

  it("warns as assembly approaches the model's window, and still runs", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      budget: {
        modelWindowTokens: 40,
        warnAtFraction: 0.5,
        hardCapTokens: null,
      },
      notes: [{ title: "big", body: "x".repeat(400) }],
    });

    const started = await run(
      harness,
      fixture.commandId,
      oneTurn,
      "warned-gesture",
    );

    expect(at(started, "warning")).toMatch(/close to the model's 40-token/);
    expect(at(started, "run.status")).toBe("running");

    // A retry is the same gesture, so it gets the same answer — warning
    // included. Losing it would make the retry look like the assembly was fine.
    const replayed = await harness.call("/runs", {
      method: "POST",
      body: {
        commandId: fixture.commandId,
        initiationKey: "warned-gesture",
        runtime: { script: oneTurn },
      },
    });

    expect(replayed.status).toBe(200);
    expect(at(replayed.body, "replayed")).toBe(true);
    expect(at(replayed.body, "warning")).toBe(at(started, "warning"));
  });

  it("refuses over an opt-in hard cap rather than truncating (principle 12)", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      budget: {
        modelWindowTokens: 1000,
        warnAtFraction: 0.9,
        hardCapTokens: 5,
      },
      notes: [{ title: "big", body: "y".repeat(400) }],
    });

    const res = await harness.call("/runs", {
      method: "POST",
      body: {
        commandId: fixture.commandId,
        initiationKey: "capped",
        runtime: { script: oneTurn },
      },
    });

    expect(res.status).toBe(409);
    expect(at(res.body, "error.details")).toEqual({ reason: "content_budget" });
    expect(at(res.body, "error.message")).toMatch(
      /remove inputs rather than truncating/,
    );
  });
});

describe("a session streams over the one event vocabulary", () => {
  it("publishes observation records and derived phases, and folds accounting", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      notes: [{ title: "ticket", body: "do the thing" }],
    });

    const ws = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`, {
      headers: { origin: `http://localhost:${harness.port}` },
    });
    const events: DomainEvent[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("error", reject);
      ws.on("message", (data) => {
        const message = JSON.parse(data.toString()) as {
          type: string;
          event?: DomainEvent;
        };
        if (message.type === "hello") resolve();
        if (message.type === "event" && message.event) {
          events.push(message.event);
        }
      });
    });

    const started = await run(harness, fixture.commandId, oneTurn);
    const sessionId = str(started, "session.id");
    const ended = await endedSession(harness, sessionId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    ws.close();

    const observations = events.filter(
      (event) => event.entity === "session_observation",
    );
    expect(observations.map((event) => at(event, "observation.kind"))).toEqual([
      "turn-started",
      "reasoning-delta",
      "output-delta",
      "output-delta",
      "tool-started",
      "tool-finished",
      "turn-ended",
      "session-ended",
    ]);
    // Stamped per session, in order, so applying one twice is a no-op.
    expect(observations.map((event) => at(event, "seqInSession"))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);

    // Phases are derived by PlotRoom from those observations (principle 7).
    const phases = events
      .filter((event) => event.entity === "session")
      .map((event) => at(event, "status.phase.kind"));
    expect(phases).toContain("thinking");
    expect(phases).toContain("responding");
    expect(phases).toContain("tool-running");

    // Accounting is folded from the observed turn, and says where cost came from.
    expect(at(ended, "session.accounting.turns")).toBe(1);
    expect(at(ended, "session.accounting.tokens.input")).toBe(120);
    expect(at(ended, "session.accounting.costBasis")).toBe("runtime-reported");
    expect(at(ended, "session.accounting.contextWindow.basis")).toBe(
      "estimated",
    );
    expect(at(ended, "session.end.kind")).toBe("ended-by-user");
    expect(at(ended, "end.workIncomplete")).toBe(true);

    // The transcript is a projection of the log, versioned on session end.
    const transcript = await harness.ok(`/sessions/${sessionId}/transcript`);
    expect(list(transcript, "turns")).toHaveLength(1);
    expect(list(transcript, "publications")).toHaveLength(1);
    expect(at(list(transcript, "publications")[0], "trigger")).toBe(
      "session-end",
    );
    const entries = list(list(transcript, "turns")[0], "entries");
    expect(entries.map((entry) => at(entry, "kind"))).toEqual([
      "reasoning",
      "output",
      "tool-call",
      "tool-result",
    ]);
    // Streamed deltas coalesce: chunking is transport, not content.
    expect(at(entries[1], "text")).toBe("here is the plan");
  });
});

describe("the producing completion loop (§3.5, principle 3)", () => {
  it("returns a failing condition as feedback, continues, then proves it", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      conditions: [
        {
          id: "output_written",
          predicate: "workspace_file_exists",
          description: "the workspace contains out.txt",
          args: { path: "out.txt" },
        },
      ],
      notes: [{ title: "ticket", body: "write out.txt" }],
    });

    const twoTries: RuntimeScript = {
      acts: [
        {
          on: "start",
          steps: [
            { observation: { kind: "turn-started", turn: 1 } },
            { observation: { kind: "output-delta", text: "done, I think" } },
            {
              observation: {
                kind: "turn-ended",
                turn: 1,
                usage: { inputTokens: 10, outputTokens: 4 },
              },
            },
            // Submitted without doing the work: PlotRoom checks, not the session.
            { submit: {} },
          ],
        },
        {
          on: "injection",
          steps: [
            { observation: { kind: "turn-started", turn: 2 } },
            { observation: { kind: "output-delta", text: "fixing it" } },
            { effect: { kind: "write-file", path: "out.txt", content: "hi" } },
            {
              observation: {
                kind: "turn-ended",
                turn: 2,
                usage: { inputTokens: 12, outputTokens: 6 },
              },
            },
            { submit: {} },
          ],
        },
      ],
    };

    const started = await run(harness, fixture.commandId, twoTries);
    const sessionId = str(started, "session.id");
    const runId = str(started, "run.id");

    const ended = await endedSession(harness, sessionId);

    // Completion is proof: the end state is `completed` only because the
    // declared condition held when PlotRoom checked it.
    expect(at(ended, "session.end.kind")).toBe("completed");
    expect(at(ended, "end.proven")).toBe(true);

    const read = await harness.ok(`/runs/${runId}`);
    expect(at(read, "run.status")).toBe("completed");
    expect(at(read, "proof.conditions.0.conditionId")).toBe("output_written");
    expect(at(read, "proof.conditions.0.holds")).toBe(true);

    // Both attempts are recorded, in order, with the feedback the first got.
    const submissions = list(read, "submissions");
    expect(submissions).toHaveLength(2);
    expect(at(submissions[0], "accepted")).toBe(false);
    expect(at(submissions[0], "feedback")).toMatch(
      /out\.txt does not exist in the workspace/,
    );
    expect(at(submissions[1], "accepted")).toBe(true);

    // The session continued within its budget: the second turn is in the log.
    expect(at(ended, "session.accounting.turns")).toBe(2);

    // The feedback is on the ledger as the product's own, authoring nothing.
    const injections = list(ended, "injections");
    expect(injections).toHaveLength(1);
    expect(at(injections[0], "origin")).toBe("condition-feedback");
    expect(at(injections[0], "author")).toBeNull();
    expect(at(injections[0], "deliveredAt")).not.toBeNull();
    expect(list(injections[0], "failedConditionIds")).toEqual([
      "output_written",
    ]);

    // And it is in the transcript as core's own `feedback` entry, naming the
    // condition — which is what makes the loop legible: the session kept going
    // because PlotRoom told it what was false (§3.5, §6.1).
    const transcript = await harness.ok(
      `/sessions/${str(started, "session.id")}/transcript`,
    );
    const feedback = list(transcript, "turns")
      .flatMap((turn) => list(turn, "entries"))
      .filter((entry) => at(entry, "kind") === "feedback");

    expect(feedback).toHaveLength(1);
    expect(at(feedback[0], "source")).toBe("world-condition");
    expect(list(feedback[0], "failedConditionIds")).toEqual(["output_written"]);
    expect(str(feedback[0], "text")).toMatch(/out\.txt does not exist/);
  });

  it("binds the produced output to the run that produced it (§15-4)", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness);

    // Something for the session to hand back: an object and the exact version of
    // it, which is what an output address resolves to.
    const produced = await harness.ok("/notes", {
      method: "POST",
      body: {
        title: "result",
        body: "what the session produced",
        workstreamId: fixture.workstream,
      },
    });

    const started = await run(harness, fixture.commandId, {
      acts: [
        {
          on: "start",
          steps: [
            { observation: { kind: "turn-started", turn: 1 } },
            {
              observation: {
                kind: "turn-ended",
                turn: 1,
                usage: { inputTokens: 3, outputTokens: 2 },
              },
            },
            {
              submit: {
                outputs: [
                  {
                    name: "result",
                    objectId: str(produced, "objectId"),
                    versionId: str(produced, "versionId"),
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const runId = str(started, "run.id");
    await endedSession(harness, str(started, "session.id"));

    // The placeholder that existed before any run now stands for a real object,
    // and it names the run it came from — `output@n` is the general address, and
    // this run is the n.
    const instantiated = await harness.ok(`/commands/${fixture.commandId}`);
    const output = list(instantiated, "outputs")[0];
    expect(at(output, "boundRunId")).toBe(runId);
    expect(at(output, "boundObjectId")).toBe(str(produced, "objectId"));
    expect(at(output, "boundAt")).not.toBeNull();

    const read = await harness.ok(`/runs/${runId}`);
    expect(at(read, "run.status")).toBe("completed");
    expect(at(read, "run.ordinal")).toBe(1);
  });

  it("refuses to call an unproven end a completion", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      conditions: [
        {
          id: "output_written",
          predicate: "workspace_file_exists",
          description: "the workspace contains out.txt",
          args: { path: "out.txt" },
        },
      ],
    });

    const claimsSuccess: RuntimeScript = {
      acts: [
        {
          on: "start",
          steps: [
            { observation: { kind: "turn-started", turn: 1 } },
            {
              observation: {
                kind: "turn-ended",
                turn: 1,
                usage: { inputTokens: 1, outputTokens: 1 },
              },
            },
            // The runtime says it completed. Nothing was proven, so it did not.
            {
              observation: {
                kind: "session-ended",
                reason: { kind: "completed" },
              },
            },
          ],
        },
      ],
    };

    const started = await run(harness, fixture.commandId, claimsSuccess);
    const ended = await endedSession(harness, str(started, "session.id"));

    expect(at(ended, "session.end.kind")).toBe("failed");
    // The wording is `checkProvenCompletion`'s, in core beside `classifyEnd`:
    // this session never submitted its declared outcome, and the record says so
    // rather than saying "unproven" in general.
    expect(at(ended, "session.end.message")).toMatch(
      /without submitting its declared outcome/,
    );
    expect(at(ended, "end.proven")).toBe(false);

    // And the run is ended too: an unproven claim must not leave run history
    // showing work still in flight.
    const read = await harness.ok(`/runs/${str(started, "run.id")}`);
    expect(at(read, "run.status")).toBe("failed");
  });

  it("names the conditions that were false when a session claims it finished", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      conditions: [
        {
          id: "output_written",
          predicate: "workspace_file_exists",
          description: "the workspace contains out.txt",
          args: { path: "out.txt" },
        },
      ],
    });

    // Submits without doing the work, gets the feedback, and then says it is
    // done anyway. The evidence PlotRoom holds is "submitted, one condition
    // false", which is a different failure from never submitting at all — and a
    // distinction the driver could not previously express.
    const started = await run(harness, fixture.commandId, {
      acts: [
        {
          on: "start",
          steps: [
            { observation: { kind: "turn-started", turn: 1 } },
            {
              observation: {
                kind: "turn-ended",
                turn: 1,
                usage: { inputTokens: 2, outputTokens: 1 },
              },
            },
            { submit: {} },
          ],
        },
        {
          on: "injection",
          steps: [
            {
              observation: {
                kind: "session-ended",
                reason: { kind: "completed" },
              },
            },
          ],
        },
      ],
    });

    const ended = await endedSession(harness, str(started, "session.id"));

    expect(at(ended, "session.end.kind")).toBe("failed");
    expect(at(ended, "session.end.message")).toMatch(
      /world conditions are false: output_written/,
    );
    expect(at(ended, "end.proven")).toBe(false);
  });

  it("refuses an open session's completion claim too, and ends its run", async () => {
    const harness = await boot(repository());
    // An open session declares no outcome, so there is nothing it could ever
    // have proven — which makes a `completed` claim from its runtime more
    // unfounded, not less (§3.5: an open session ends when the user ends it).
    const fixture = await command(harness, { lifecycle: "open" });

    const started = await run(harness, fixture.commandId, {
      acts: [
        {
          on: "start",
          steps: [
            { observation: { kind: "turn-started", turn: 1 } },
            { observation: { kind: "output-delta", text: "all done" } },
            {
              observation: {
                kind: "turn-ended",
                turn: 1,
                usage: { inputTokens: 2, outputTokens: 2 },
              },
            },
            {
              observation: {
                kind: "session-ended",
                reason: { kind: "completed" },
              },
            },
          ],
        },
      ],
    });

    const ended = await endedSession(harness, str(started, "session.id"));

    expect(at(ended, "session.end.kind")).toBe("failed");
    // Core's own reason for this case: an open session declares no outcome, so
    // it could never have proven one.
    expect(at(ended, "session.end.message")).toMatch(
      /declares no outcome and so can never have proven one/,
    );
    expect(at(ended, "end.proven")).toBe(false);

    // The invariant that matters for run history: no ended session leaves a
    // running run behind.
    const read = await harness.ok(`/runs/${str(started, "run.id")}`);
    expect(at(read, "run.status")).not.toBe("running");
    expect(at(read, "run.endedAt")).not.toBeNull();
  });

  it("proves the same submission whether a runtime or the API asked (principle 8)", async () => {
    const harness = await boot(repository());
    // No declared conditions: there is nothing to fail, and "every declared
    // condition was evaluated and holds" is vacuously true — the proof still
    // records what was checked.
    const fixture = await command(harness);
    const started = await run(harness, fixture.commandId, neverEnds);
    const sessionId = str(started, "session.id");

    const result = await harness.ok(`/sessions/${sessionId}/submit`, {
      method: "POST",
      body: {},
    });

    expect(at(result, "accepted")).toBe(true);
    expect(typeof at(result, "proof.provenAt")).toBe("number");

    const ended = await endedSession(harness, sessionId);
    expect(at(ended, "session.end.kind")).toBe("completed");
    expect(at(ended, "end.proven")).toBe(true);

    // Submitting again is refused as an answer, not as a crash: proof is
    // written once and a finished run is never silently re-ended (§3.5).
    const again = await harness.ok(`/sessions/${sessionId}/submit`, {
      method: "POST",
      body: {},
    });
    expect(at(again, "accepted")).toBe(false);
    expect(at(again, "feedback")).toMatch(/already ended as completed/);
  });

  it("says so when a declared condition has no checker at all", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      conditions: [
        {
          id: "checks_green",
          predicate: "github_checks_green",
          description: "the PR's checks are green",
        },
      ],
    });

    const started = await run(harness, fixture.commandId, {
      acts: [
        {
          on: "start",
          steps: [
            { observation: { kind: "turn-started", turn: 1 } },
            {
              observation: {
                kind: "turn-ended",
                turn: 1,
                usage: { inputTokens: 1, outputTokens: 1 },
              },
            },
            { submit: {} },
          ],
        },
      ],
    });

    const sessionId = str(started, "session.id");
    const runId = str(started, "run.id");

    const read = await waitFor(async () => {
      const current = await harness.ok(`/runs/${runId}`);
      return list(current, "submissions").length > 0 ? current : null;
    }, "a recorded submission");

    expect(at(read, "run.status")).toBe("running");
    expect(at(read, "submissions.0.accepted")).toBe(false);
    expect(at(read, "submissions.0.feedback")).toMatch(
      /no checker is available for predicate "github_checks_green"/,
    );

    // Still running, still steerable: an unprovable condition is not a failure.
    const session = await harness.ok(`/sessions/${sessionId}`);
    expect(at(session, "session.end")).toBeNull();
  });
});

describe("end states are distinct (§3.6, principle 11)", () => {
  it("stops a session by user, and the run stops with it (§6.7)", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness);
    const started = await run(harness, fixture.commandId, neverEnds);
    const sessionId = str(started, "session.id");

    const stopped = await harness.ok(`/sessions/${sessionId}/stop`, {
      method: "POST",
      body: { mode: "graceful" },
    });

    expect(at(stopped, "session.end.kind")).toBe("stopped");
    expect(at(stopped, "session.end.by")).toBe("user");
    expect(at(stopped, "end.stopped")).toBe(true);
    expect(at(stopped, "end.failed")).toBe(false);

    const read = await harness.ok(`/runs/${str(started, "run.id")}`);
    expect(at(read, "run.status")).toBe("stopped");
  });

  it("records an out-of-budget stop as its own outcome, not a failure (§8)", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness);
    const started = await run(harness, fixture.commandId, neverEnds);
    const sessionId = str(started, "session.id");

    const stopped = await harness.ok(`/sessions/${sessionId}/stop`, {
      method: "POST",
      body: { mode: "hard", cause: "budget", scope: "workstream" },
    });

    expect(at(stopped, "session.end.kind")).toBe("out-of-budget");
    expect(at(stopped, "session.end.scope")).toBe("workstream");
    expect(at(stopped, "end.failed")).toBe(false);
    // The one outcome a retry may not blindly re-run (§3.6).
    expect(at(stopped, "end.safeToRetryBlindly")).toBe(false);

    const read = await harness.ok(`/runs/${str(started, "run.id")}`);
    expect(at(read, "run.status")).toBe("out_of_budget");
  });

  it("refuses to end a producing session as if the user had ended it", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness);
    const started = await run(harness, fixture.commandId, neverEnds);

    const res = await harness.call(
      `/sessions/${str(started, "session.id")}/end`,
      { method: "POST", body: {} },
    );

    expect(res.status).toBe(409);
    expect(at(res.body, "error.details")).toEqual({
      reason: "producing_session",
    });
  });

  it("interrupts a live session at a graceful shutdown rather than orphaning it", async () => {
    const repositoryPath = gitRepository();
    const stateDir = mkdtempSync(join(tmpdir(), "plotroom-shutdown-"));
    scratch.push(stateDir);

    const first = await boot({ workspace: { repositoryPath } }, { stateDir });
    const fixture = await command(first);
    const started = await run(first, fixture.commandId, neverEnds);
    const sessionId = str(started, "session.id");
    const runId = str(started, "run.id");

    // The session is genuinely in flight when the server is asked to close: it
    // has been observed streaming, and nothing has ended it.
    await waitFor(async () => {
      const read = await first.ok(`/sessions/${sessionId}`);
      return at(read, "status.phase.kind") === "responding" ? read : null;
    }, "the session to be observed streaming");
    expect(first.handle.hub.ids()).toContain(sessionId);

    await first.handle.close();
    harnesses.splice(harnesses.indexOf(first), 1);

    // Read the state directory directly, with no server running: this is the
    // record as the shutdown left it, not something a later boot tidied up.
    const state = openDatabase({ stateDir });
    try {
      const stored = new SessionStore(state).get(sessionId);
      const end = stored.session.end as SessionEnd;

      expect(end.kind).toBe("interrupted");
      expect((end as { readonly message: string }).message).toMatch(
        /server shut down/,
      );
      // Nobody stopped this work and it did not fail (principle 11).
      expect(endStateFacts(end).stopped).toBe(false);
      expect(endStateFacts(end).failed).toBe(false);
      expect(endStateFacts(end).resumable).toBe(true);

      // And the run says the same thing the session does: not left looking like
      // work in flight, and not rounded to "stopped" either — nobody stopped it.
      expect(new RunStore(state).run(runId).status).toBe("interrupted");
    } finally {
      state.close();
    }

    // Nothing is left for the next boot to recover, because nothing was
    // orphaned — and the record still says what actually happened.
    const second = await boot({ workspace: { repositoryPath } }, { stateDir });
    await expect(second.handle.recovered).resolves.toMatchObject({
      interrupted: [],
    });
    const recovered = await second.ok(`/sessions/${sessionId}`);
    expect(at(recovered, "session.end.message")).toMatch(/server shut down/);
  });

  it("marks a session the last process died on as interrupted at the next boot", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "plotroom-crash-"));
    scratch.push(stateDir);

    // A crash leaves a live session record with no end and no process. Written
    // directly here, because that is exactly the state a killed process leaves
    // behind and the only state next-boot recovery exists for.
    const first = await boot({}, { stateDir });
    const workstreamId = str(
      await first.ok("/workstreams", { method: "POST", body: {} }),
      "workstream.id",
    );
    await first.handle.close();
    harnesses.splice(harnesses.indexOf(first), 1);

    const state = openDatabase({ stateDir });
    const orphan = new SessionStore(state).start({
      workstreamId,
      mode: "open",
      launch: {
        model: "fixture-model",
        effort: "medium",
        toolPermissions: INHERIT_APP_TOOLS,
      },
      initiatedBy: humanAuthor,
      runtime: { adapterId: "scripted", ref: "native-crashed" },
    });
    state.close();

    const second = await boot({}, { stateDir });
    const recovered = await second.ok(`/sessions/${orphan.session.id}`);

    expect(at(recovered, "session.end.kind")).toBe("interrupted");
    expect(at(recovered, "session.end.message")).toMatch(/server restarted/);
    // Not stopped and not failed, and resumable like any session (§3.6).
    expect(at(recovered, "end.stopped")).toBe(false);
    expect(at(recovered, "end.failed")).toBe(false);
    expect(at(recovered, "end.resumable")).toBe(true);
    expect(at(recovered, "end.wantsDecision")).toBe(true);
  });

  it("frees an initiation key no attempt can still hold, at the next boot", async () => {
    const repositoryPath = gitRepository();
    const stateDir = mkdtempSync(join(tmpdir(), "plotroom-stranded-"));
    scratch.push(stateDir);

    const first = await boot({ workspace: { repositoryPath } }, { stateDir });
    const fixture = await command(first);
    await first.handle.close();
    harnesses.splice(harnesses.indexOf(first), 1);

    // A process that died between claiming a key and settling it leaves this: a
    // claim with no run behind it, which would otherwise refuse that gesture
    // forever (principle 9).
    const state = openDatabase({ stateDir });
    expect(
      new RunStore(state).claimInitiation("stranded-gesture", fixture.commandId)
        .state,
    ).toBe("claimed");
    state.close();

    const second = await boot({ workspace: { repositoryPath } }, { stateDir });
    await expect(second.handle.recovered).resolves.toMatchObject({
      freedInitiationKeys: ["stranded-gesture"],
    });

    // The same gesture runs, instead of being told it is already starting.
    const res = await second.call("/runs", {
      method: "POST",
      body: {
        commandId: fixture.commandId,
        initiationKey: "stranded-gesture",
        runtime: { script: oneTurn },
      },
    });

    expect(res.status).toBe(201);
    expect(at(res.body, "replayed")).toBe(false);
  });
});

describe("the reflexivity rule reads real lineage (principle 1)", () => {
  it("refuses a running session authoring context into itself", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, {
      notes: [{ title: "ticket", body: "do the thing" }],
    });
    const started = await run(harness, fixture.commandId, neverEnds);
    const sessionId = str(started, "session.id");

    // The session's own node, placed by the run path.
    const snapshot = await harness.ok("/snapshot");
    const sessionNode = list(snapshot, "nodes").find(
      (node) => at(node, "refId") === sessionId,
    );
    const noteNode = list(snapshot, "nodes").find(
      (node) => at(node, "refId") === fixture.noteIds[0],
    );
    expect(sessionNode).toBeDefined();

    const refusedForSession = await harness.call("/edges", {
      method: "POST",
      actor: `session:${sessionId}`,
      body: { from: str(noteNode, "id"), to: str(sessionNode, "id") },
    });

    expect(refusedForSession.status).toBe(409);
    expect(at(refusedForSession.body, "error.details")).toEqual({
      reason: "own_chain",
    });

    // The human is unconstrained: same wire, same target, allowed.
    const allowed = await harness.call("/edges", {
      method: "POST",
      body: { from: str(noteNode, "id"), to: str(sessionNode, "id") },
    });
    expect(allowed.status).toBe(201);
  });
});
