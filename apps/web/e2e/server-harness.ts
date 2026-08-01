/**
 * Spawns a real `@plotroom/server` for the milestone gate: an ephemeral
 * loopback port, a temp state dir, a real local git repository as the
 * workstream's repo (provisioning uses `git worktree`, same as
 * `apps/server/src/routes/runs.integration.test.ts`'s harness), the
 * scripted runtime selected via `PLOTROOM_RUNTIME` with a default script
 * written to a temp file (`PLOTROOM_RUNTIME_SCRIPT`) so the canvas's own
 * "run" gesture — which never names a runtime or a script itself — picks it
 * up exactly like a real launch would name a real adapter.
 *
 * `PLOTROOM_STATIC_DIR` points at the real, built `apps/web/dist` (not a
 * fake path the way the Sync 2 gate's fetch/WS-only harness uses) — this
 * gate loads the actually-served page, single origin, and drives it with a
 * real browser tab.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_ENTRY = fileURLToPath(
  new URL("../../server/dist/index.js", import.meta.url),
);
const WEB_DIST = fileURLToPath(new URL("../dist", import.meta.url));

/**
 * An OS-assigned free port (review finding n1): a fixed, incrementing
 * counter starting from a hardcoded base could hand out a port a *leaked*
 * prior server (a run this suite forgot to kill) is still bound to —
 * `waitForHealth` would then happily report the stale process healthy, and
 * every assertion after that would run against the wrong server entirely.
 * Binding a throwaway socket to port 0 and reading back what the OS
 * assigned cannot collide with anything already listening, leaked or not.
 * `apps/server` cannot itself be asked to bind port 0 and report the real
 * port back (its own "server started" log line only ever echoes the
 * *configured* port, and that file is out of this track's scope) — this is
 * the bind-probe alternative the review named for exactly that reason.
 * There is a narrow TOCTOU window between closing the probe and the child
 * actually binding; acceptable for test tooling, and still strictly safer
 * than a static counter.
 */
function ephemeralPort(): Promise<number> {
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

/** A real repository to branch from: provisioning uses `git worktree`. */
function gitRepository(scratch: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "plotroom-e2e-repo-"));
  scratch.push(dir);

  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });

  git("init", "--initial-branch", "main");
  git("config", "user.email", "e2e@plotroom.invalid");
  git("config", "user.name", "PlotRoom E2E");
  writeFileSync(join(dir, "README.md"), "# fixture\n", "utf8");
  git("add", ".");
  git("commit", "-m", "initial");

  return dir;
}

/**
 * The scripted runtime's default script (`apps/server/src/runtime/
 * scripted.ts`'s documented format): a first attempt that submits without
 * having done the work — the declared world condition (`out.txt` must
 * exist) fails, so PlotRoom's completion loop hands feedback back and the
 * session continues — then, on that injected feedback, a second attempt
 * that actually writes the file and submits again, which the same
 * condition now proves. This is the fail-then-pass loop the gate exists to
 * watch stream live.
 *
 * `delay` steps (real wall-clock, capped at 5000ms, `apps/server/src/
 * runtime/scripted.ts`) pace turn 1 over a couple of seconds on purpose: a
 * script that replayed a whole session inside one tick would make "streams
 * live" pass for the wrong reason — the panel opened, refetched once, and
 * simply found the session already finished. Spread out like this, the
 * milestone gate's own assertions only pass if content the panel did not
 * have at open time arrives afterward, over `/ws`, while the session is
 * still running.
 */
export const MILESTONE_SCRIPT = {
  acts: [
    {
      on: "start",
      steps: [
        { observation: { kind: "turn-started", turn: 1 } },
        // The panel opens well inside this window (see milestone.spec.ts):
        // long enough that every UI step before it — drag-drop, run, wait
        // for the session node, select it, open the panel — has room to
        // finish first, however long a particular run of the suite takes.
        { delay: { ms: 2_500 } },
        {
          observation: {
            kind: "reasoning-delta",
            text: "checking whether out.txt already exists",
          },
        },
        // A second pause between reasoning and output: two more live
        // updates to the same, already-open panel, not one.
        { delay: { ms: 1_200 } },
        {
          observation: {
            kind: "output-delta",
            text: "I believe the work is already done.",
          },
        },
        {
          observation: {
            kind: "turn-ended",
            turn: 1,
            usage: { inputTokens: 20, outputTokens: 8 },
          },
        },
        // Submitted without doing the work: PlotRoom checks, not the
        // session (the completion loop, §3.5).
        { submit: {} },
      ],
    },
    {
      on: "injection",
      steps: [
        { observation: { kind: "turn-started", turn: 2 } },
        // Turn 2 also streams, not just materializes at once — the same
        // proof as turn 1's pauses, for the feedback-driven continuation.
        { delay: { ms: 1_000 } },
        {
          observation: {
            kind: "reasoning-delta",
            text: "the feedback says out.txt is missing; writing it now",
          },
        },
        { observation: { kind: "output-delta", text: "writing out.txt" } },
        {
          observation: {
            kind: "tool-started",
            toolName: "write_file",
            callId: "c1",
            input: { path: "out.txt" },
          },
        },
        { effect: { kind: "write-file", path: "out.txt", content: "done" } },
        {
          observation: {
            kind: "tool-finished",
            callId: "c1",
            output: "wrote out.txt",
            isError: false,
          },
        },
        {
          observation: {
            kind: "turn-ended",
            turn: 2,
            usage: { inputTokens: 15, outputTokens: 10 },
          },
        },
        { submit: {} },
      ],
    },
  ],
};

async function waitForHealth(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() >= deadline) {
      throw new Error(`server on port ${port} never became healthy`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export interface MilestoneServer {
  readonly port: number;
  readonly baseUrl: string;
  readonly stateDir: string;
  readonly repositoryPath: string;
  stop(): Promise<void>;
}

function killAndWait(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve();
    };
    child.once("exit", finish);
    child.kill();
    // A hung server process must never hang teardown.
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
  });
}

export interface StartServerOptions {
  /**
   * The server-wide default script a run falls back to when it names no
   * `runtime.script` of its own (`POST /api/runs`'s own per-run override,
   * which every gate that needs several distinctly-behaved sessions at
   * once uses instead of relying on this default). Defaults to
   * `MILESTONE_SCRIPT`, unchanged from every existing call site.
   */
  readonly defaultScript?: unknown;
  /**
   * `PLOTROOM_CONCURRENCY_LIMIT` (default 4, `apps/server/src/config.ts`).
   * A gate that starts more concurrent sessions than the default limit
   * raises this so every one of them starts immediately rather than a
   * later one landing in the queue (§4.1) — a gate proving steering
   * mechanics is not the place to also prove queue admission, which has
   * its own server-side coverage already.
   */
  readonly concurrencyLimit?: number;
}

export async function startMilestoneServer(
  options: StartServerOptions = {},
): Promise<MilestoneServer> {
  const scratch: string[] = [];
  let child: ChildProcess | undefined;

  // Review finding n6: a failure *inside* this function (git init, the
  // health wait timing out, ...) must not leak a spawned process or scratch
  // directories just because nothing ever returned to hand them to a
  // caller's `stop()`. Whatever this attempt already created is torn down
  // before the error propagates, the same as a successful run's `stop()`
  // would, rather than relying solely on the caller's `afterAll` to guard a
  // `server` that never got assigned.
  try {
    const repositoryPath = gitRepository(scratch);
    const stateDir = mkdtempSync(join(tmpdir(), "plotroom-e2e-state-"));
    scratch.push(stateDir);

    const workspaceDir = join(stateDir, "workspaces");
    mkdirSync(workspaceDir, { recursive: true });

    const scriptPath = join(stateDir, "milestone-script.json");
    writeFileSync(
      scriptPath,
      JSON.stringify(options.defaultScript ?? MILESTONE_SCRIPT),
      "utf8",
    );

    const port = await ephemeralPort();

    child = spawn(process.execPath, [SERVER_ENTRY], {
      stdio: "ignore",
      env: {
        ...process.env,
        PLOTROOM_PORT: String(port),
        PLOTROOM_STATE_DIR: stateDir,
        PLOTROOM_STATIC_DIR: WEB_DIST,
        PLOTROOM_LOG_LEVEL: "error",
        PLOTROOM_RUNTIME: "scripted",
        PLOTROOM_RUNTIME_SCRIPT: scriptPath,
        PLOTROOM_WORKSPACE_REPO: repositoryPath,
        PLOTROOM_WORKSPACE_DIR: workspaceDir,
        ...(options.concurrencyLimit === undefined
          ? {}
          : {
              PLOTROOM_CONCURRENCY_LIMIT: String(options.concurrencyLimit),
            }),
      },
    });

    await waitForHealth(port);

    const started = child;
    return {
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      stateDir,
      repositoryPath,
      stop: async () => {
        await killAndWait(started);
        for (const dir of scratch)
          rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (child) await killAndWait(child);
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** A same-origin, loopback-trusted POST (spec §12) — this test's own seeding. */
export async function apiPost<T>(
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `${path} failed: ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

/**
 * A same-origin, loopback-trusted GET — for asserting real server state
 * (e.g. a session's recorded end reason) directly, rather than only through
 * whatever the UI happens to render, the same "seed via the API, prove via
 * the API" split `apiPost` already gives seeding.
 */
export async function apiGet<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { origin: baseUrl },
  });
  if (!response.ok) {
    throw new Error(
      `${path} failed: ${response.status} ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}
