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
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_ENTRY = fileURLToPath(
  new URL("../../server/dist/index.js", import.meta.url),
);
const WEB_DIST = fileURLToPath(new URL("../dist", import.meta.url));

let nextPort = 47_900;
function ephemeralPort(): number {
  nextPort += 1;
  return nextPort;
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
 */
export const MILESTONE_SCRIPT = {
  acts: [
    {
      on: "start",
      steps: [
        { observation: { kind: "turn-started", turn: 1 } },
        {
          observation: {
            kind: "reasoning-delta",
            text: "checking whether out.txt already exists",
          },
        },
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

export async function startMilestoneServer(): Promise<MilestoneServer> {
  const scratch: string[] = [];
  const repositoryPath = gitRepository(scratch);
  const stateDir = mkdtempSync(join(tmpdir(), "plotroom-e2e-state-"));
  scratch.push(stateDir);

  const workspaceDir = join(stateDir, "workspaces");
  mkdirSync(workspaceDir, { recursive: true });

  const scriptPath = join(stateDir, "milestone-script.json");
  writeFileSync(scriptPath, JSON.stringify(MILESTONE_SCRIPT), "utf8");

  const port = ephemeralPort();

  const child = spawn(process.execPath, [SERVER_ENTRY], {
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
    },
  });

  await waitForHealth(port);

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    stateDir,
    repositoryPath,
    stop: () =>
      new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(killTimer);
          for (const dir of scratch)
            rmSync(dir, { recursive: true, force: true });
          resolve();
        };
        child.once("exit", finish);
        child.kill();
        // A hung server process must never hang teardown.
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
      }),
  };
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
