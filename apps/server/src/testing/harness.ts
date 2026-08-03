import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadServerConfig, type ServerConfigOverrides } from "../config.js";
import { startServer } from "../index.js";
import type { RuntimeScript } from "../runtime/scripted.js";

/**
 * A real server, over HTTP, for the integration suites (Epics 4.2, 5.5).
 *
 * Every test that uses this drives the actual app: a real SQLite state directory,
 * a real git repository to branch from, and the **scripted** runtime selected.
 * That runtime shares every line downstream of the seam with the pi adapter — the
 * observation log, the phase reducer, the claim gate, accounting, the WS stream,
 * the completion loop — so what these suites prove is true of a real session too
 * (decision 0001's whole point).
 *
 * This lives outside a `.test.ts` file so more than one suite can boot the same
 * way. Nothing in it registers a route, so the tool-catalog check that reads
 * `routes/` is unaffected.
 */
export interface Harness {
  readonly handle: ReturnType<typeof startServer>;
  readonly stateDir: string;
  readonly port: number;
  call(path: string, options?: CallOptions): Promise<CallResult>;
  ok(path: string, options?: CallOptions): Promise<unknown>;
}

export interface CallOptions {
  readonly method?: string;
  readonly body?: unknown;
  /** `human` (the default) or `session:<id>`; the attribution header (§15-2). */
  readonly actor?: string;
}

export interface CallResult {
  readonly status: number;
  readonly body: unknown;
}

/**
 * A port the OS says is free, rather than one this module guessed.
 *
 * Per-worker bands were the previous answer and they were not enough: a band is
 * still a static range, so a leaked server from an earlier run, another suite's
 * harness, or anything else on the machine can already hold a port in it — and the
 * failure is not always a clean `EADDRINUSE`. It can be requests landing on *the
 * other server*, which surfaces as an unrelated refusal somewhere far away.
 *
 * Binding a throwaway socket to port 0 and reading back what the OS assigned cannot
 * collide with anything already listening, leaked or not. It is the same probe
 * `apps/web`'s e2e harness uses, and its own comment names the reason PlotRoom's
 * server cannot simply be told to bind 0 itself: `startServer` reports the
 * *configured* port, so a caller asking for 0 would not learn which port it got.
 * There is a narrow window between closing the probe and the child binding;
 * acceptable for test tooling, and strictly safer than a counter.
 */
export function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() =>
          reject(new Error("could not determine an ephemeral port")),
        );
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * A key unique to this process, so "the same gesture" means the same gesture and two
 * suites cannot collide on one (principle 9's own mechanism, applied to the harness).
 */
const worker = Number(
  process.env.VITEST_WORKER_ID ?? process.env.VITEST_POOL_ID ?? 1,
);

const harnesses: Harness[] = [];
const scratch: string[] = [];

/** Call from an `afterEach`: closes every server and removes every temp dir. */
export async function cleanupHarnesses(): Promise<void> {
  for (const harness of harnesses.splice(0)) {
    await harness.handle.close();
  }
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A real repository to branch from: provisioning uses `git worktree`. */
export function gitRepository(): string {
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

export const repository = (): ServerConfigOverrides => ({
  workspace: { repositoryPath: gitRepository() },
});

export async function boot(
  overrides: ServerConfigOverrides = {},
  options: { readonly stateDir?: string } = {},
): Promise<Harness> {
  const thisPort = await ephemeralPort();
  const stateDir =
    options.stateDir ?? mkdtempSync(join(tmpdir(), "plotroom-int-test-"));
  if (options.stateDir === undefined) scratch.push(stateDir);

  const workspaceDir = join(stateDir, "workspaces");
  mkdirSync(workspaceDir, { recursive: true });

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
        // No plugin workers unless the suite asks for them: a boot that started
        // three worker threads no assertion mentions would make every suite pay
        // for the plugin platform. `plugins.integration.test.ts` is where the
        // in-box list and the fixtures are mounted deliberately.
        pluginsInBox: [],
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
  // Whatever plugins this boot was given have loaded and reported their health, so
  // a test reads a settled `/api/plugins` rather than racing the workers.
  await handle.pluginsBooted;

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

/* ------------------------------------------------------------------- reading */

export function at(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (current, key) => (current as Record<string, unknown>)?.[key],
      value,
    );
}

export function str(value: unknown, path: string): string {
  const found = at(value, path);
  if (typeof found !== "string") {
    throw new Error(
      `expected a string at ${path}, got ${JSON.stringify(found)}`,
    );
  }
  return found;
}

export function list(value: unknown, path: string): unknown[] {
  const found = at(value, path);
  if (!Array.isArray(found)) {
    throw new Error(
      `expected an array at ${path}, got ${JSON.stringify(found)}`,
    );
  }
  return found;
}

export async function waitFor<T>(
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

export interface CommandFixture {
  readonly workstream: string;
  readonly commandId: string;
  readonly commandNodeId: string;
  readonly definitionId: string;
  readonly noteIds: readonly string[];
}

export interface DefineOptions {
  readonly name?: string;
  readonly workstreamId?: string;
  readonly conditions?: readonly {
    readonly id: string;
    readonly predicate: string;
    readonly description: string;
    readonly args?: Record<string, string>;
  }[];
  readonly lifecycle?: "producing" | "open";
  readonly notes?: readonly { readonly title: string; readonly body: string }[];
  /** Declared outputs, so a downstream command can be wired to a placeholder. */
  readonly outputs?: readonly {
    readonly name: string;
    readonly kind: string;
  }[];
}

/** A workstream with a command and its ordered context (§3.5). */
export async function command(
  harness: Harness,
  options: DefineOptions = {},
): Promise<CommandFixture> {
  const workstream =
    options.workstreamId ??
    str(
      await harness.ok("/workstreams", { method: "POST", body: {} }),
      "workstream.id",
    );

  const lifecycle = options.lifecycle ?? "producing";
  const definition = await harness.ok("/command-definitions", {
    method: "POST",
    body: {
      name: options.name ?? "Implement the ticket",
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
    commandNodeId: commandNode,
    definitionId: str(definition, "definition.id"),
    noteIds,
  };
}

let gesture = 0;

/**
 * A key unique to this worker, so "the same gesture" means the same gesture and
 * two suites cannot collide on one (principle 9's own mechanism, applied to the
 * test harness).
 */
function nextGesture(): string {
  gesture += 1;
  return `gesture-${worker}-${gesture}`;
}

/** Run one command through the real run path, with a declared script. */
export async function run(
  harness: Harness,
  commandId: string,
  script: RuntimeScript,
  options: { readonly actor?: string } = {},
): Promise<unknown> {
  return harness.ok("/runs", {
    method: "POST",
    body: {
      commandId,
      initiationKey: nextGesture(),
      runtime: { script },
    },
    ...(options.actor === undefined ? {} : { actor: options.actor }),
  });
}

/** Wait until a session has an end recorded, then read it whole. */
export async function endedSession(
  harness: Harness,
  sessionId: string,
): Promise<unknown> {
  return waitFor(async () => {
    const read = await harness.ok(`/sessions/${sessionId}`);
    return at(read, "session.end") === null ? null : read;
  }, `session ${sessionId} to end`);
}
