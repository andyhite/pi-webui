/**
 * A restart-capable variant of `server-harness.ts`'s `startMilestoneServer`,
 * for one thing that harness deliberately cannot do: kill the server child
 * **without** deleting its state directory, then spawn a fresh child pointed
 * at the exact same `plotroom.db` — so a hardening test can prove a fact
 * survives a restart (AGENTS.md: "Durability and cleanup... the portable unit
 * is the state directory's `plotroom.db` plus `blobs/`").
 *
 * `server-harness.ts` is out of this batch's file ownership (shared by every
 * other e2e spec); this is a new, narrow, test-only helper rather than an
 * edit to it. Everything below is deliberately smaller than that file's own
 * `startMilestoneServer`: no default script (every run in the specs that use
 * this supplies its own `runtime.script`), no browser-facing static dir
 * requirement beyond what `apps/server` already needs to boot.
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

function gitRepository(dir: string): void {
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
  readonly port: number;
  readonly baseUrl: string;
  /** The one thing that must be identical across a restart: `plotroom.db` + `blobs/`. */
  readonly stateDir: string;
  readonly repositoryPath: string;
  readonly workspaceDir: string;
  readonly child: ChildProcess;
}

export interface StartRestartableServerOptions {
  readonly concurrencyLimit?: number;
  /** Reuse an existing state dir / repo instead of provisioning fresh ones — a restart. */
  readonly reuse?: {
    readonly stateDir: string;
    readonly repositoryPath: string;
    readonly workspaceDir: string;
  };
}

/**
 * Start a server. With no `reuse` option this provisions a fresh state
 * directory and git repository (a first boot); with one, it spawns against
 * the exact same directories a prior instance used (a restart on the same
 * state dir) — the same distinction `PLOTROOM_STATE_DIR` itself draws.
 */
export async function startRestartableServer(
  options: StartRestartableServerOptions = {},
): Promise<RestartableServer> {
  const stateDir =
    options.reuse?.stateDir ??
    mkdtempSync(join(tmpdir(), "plotroom-e2e-restart-state-"));
  const repositoryPath =
    options.reuse?.repositoryPath ??
    mkdtempSync(join(tmpdir(), "plotroom-e2e-restart-repo-"));
  const workspaceDir =
    options.reuse?.workspaceDir ?? join(stateDir, "workspaces");

  if (options.reuse === undefined) {
    gitRepository(repositoryPath);
    mkdirSync(workspaceDir, { recursive: true });
  }

  const port = await ephemeralPort();

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    stdio: "ignore",
    env: {
      ...process.env,
      PLOTROOM_PORT: String(port),
      PLOTROOM_STATE_DIR: stateDir,
      PLOTROOM_STATIC_DIR: WEB_DIST,
      PLOTROOM_LOG_LEVEL: "error",
      PLOTROOM_RUNTIME: "scripted",
      PLOTROOM_WORKSPACE_REPO: repositoryPath,
      PLOTROOM_WORKSPACE_DIR: workspaceDir,
      ...(options.concurrencyLimit === undefined
        ? {}
        : { PLOTROOM_CONCURRENCY_LIMIT: String(options.concurrencyLimit) }),
    },
  });

  await waitForHealth(port);

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    stateDir,
    repositoryPath,
    workspaceDir,
    child,
  };
}

/** Kill the child, but leave `stateDir`/`repositoryPath` on disk — a crash, not a teardown. */
export async function killKeepingState(
  server: RestartableServer,
): Promise<void> {
  await killAndWait(server.child);
}

/** The full teardown: kill (if still alive) and remove every scratch directory. */
export async function stopAndClean(server: RestartableServer): Promise<void> {
  await killAndWait(server.child);
  rmSync(server.stateDir, { recursive: true, force: true });
  rmSync(server.repositoryPath, { recursive: true, force: true });
}
