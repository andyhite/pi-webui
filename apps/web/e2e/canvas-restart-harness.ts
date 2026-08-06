/**
 * A minimal, standalone spawn helper for exactly one thing `server-harness.ts`
 * cannot do: kill a running server and respawn it on the *same* state
 * directory (and repository/workspace paths), so a durability assertion can
 * prove data survived the process boundary rather than merely surviving
 * within one process's lifetime.
 *
 * `server-harness.ts`'s own `stop()` deletes every scratch directory it
 * created — the right behavior for every other gate, which never needs the
 * state dir again once its test ends. Changing that shared contract's
 * meaning for every other spec (e.g. adding a "kill but keep the dir" verb to
 * it) is out of this batch's file ownership, so this file duplicates the
 * small spawn/health-probe primitives `startMilestoneServer` already has,
 * scoped to exactly the one gate that needs a real process restart
 * (`canvas-arrangement-durability.spec.ts`).
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

/** Same reasoning as `server-harness.ts`'s own `ephemeralPort`: an OS-assigned free port, never a guessed one. */
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

function gitRepository(scratch: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "plotroom-e2e-restart-repo-"));
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
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 3_000);
  });
}

export interface RestartableServer {
  /** The currently live base URL — changes after `restart()` (a fresh ephemeral port; only the state dir is the durability claim under test). */
  readonly baseUrl: string;
  readonly stateDir: string;
  /**
   * Kills the current process with no cleanup and spawns a fresh one against
   * the *same* `PLOTROOM_STATE_DIR`, waiting for the new process's own health
   * check — the whole point being that nothing about the state directory is
   * touched in between.
   */
  restart(): Promise<void>;
  /** Kills the process and removes every scratch directory. Call exactly once, at the very end. */
  stop(): Promise<void>;
}

export async function startRestartableServer(): Promise<RestartableServer> {
  const scratch: string[] = [];
  let child: ChildProcess | undefined;

  try {
    const repositoryPath = gitRepository(scratch);
    const stateDir = mkdtempSync(join(tmpdir(), "plotroom-e2e-restart-state-"));
    scratch.push(stateDir);

    const workspaceDir = join(stateDir, "workspaces");
    mkdirSync(workspaceDir, { recursive: true });

    const port = await ephemeralPort();

    const spawnOn = async (p: number): Promise<ChildProcess> => {
      const spawned = spawn("bun", [SERVER_ENTRY], {
        stdio: "ignore",
        env: {
          ...process.env,
          PLOTROOM_PORT: String(p),
          PLOTROOM_STATE_DIR: stateDir,
          PLOTROOM_STATIC_DIR: WEB_DIST,
          PLOTROOM_LOG_LEVEL: "error",
          PLOTROOM_RUNTIME: "scripted",
          PLOTROOM_WORKSPACE_REPO: repositoryPath,
          PLOTROOM_WORKSPACE_DIR: workspaceDir,
        },
      });
      await waitForHealth(p);
      return spawned;
    };

    child = await spawnOn(port);

    const state = { port };

    return {
      get baseUrl() {
        return `http://127.0.0.1:${state.port}`;
      },
      stateDir,
      restart: async () => {
        if (!child) throw new Error("no server process to restart");
        await killAndWait(child);
        // A fresh ephemeral port: the OS may not release the old one
        // instantly, and nothing about durability requires the identical
        // port — only the identical state dir is the claim under test
        // (§12: the state directory is the durable, portable unit).
        state.port = await ephemeralPort();
        child = await spawnOn(state.port);
      },
      stop: async () => {
        if (child) await killAndWait(child);
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
