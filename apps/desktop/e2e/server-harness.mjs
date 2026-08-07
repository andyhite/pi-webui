// #317's native shell suite: the real Tauri shell (`cargo build`'s debug
// binary, `src-tauri/target/debug/plotroom-desktop`) spawns the real
// compiled server sidecar itself on launch (`spawn_or_attach.rs`/
// `sidecar.rs`) — this harness's only job is to give that sidecar a real
// workspace to start against, the same way `apps/web/e2e/server-harness.ts`
// does for the browser gate, and to seed one canvas node through the
// server's own HTTP API once it is up.
//
// `prepareEnv()` MUST run, and its returned `env` MUST be applied to
// `process.env`, before `@wdio/tauri-service` spawns the app binary
// (`wdio.conf.mjs`'s top-level `await`, before `export const config`):
// `Command::new(...)` in `sidecar.rs`'s `ServerSpawner::spawn` inherits this
// process's environment by default (never cleared), so setting these here,
// early enough, is what reaches the spawned server sidecar two processes
// down.
//
// A fixed port and fixed scratch paths, deliberately, not
// `apps/web/e2e/server-harness.ts`'s ephemeral-port-plus-`mkdtempSync`
// approach: `wdio.conf.mjs` is imported twice per run — once by the CLI
// launcher process, which is what actually spawns the app binary during its
// `onPrepare`, and again by the forked worker process that runs the spec
// file and reads `globalThis.__plotroomDesktopE2E__` back out. Two
// independent calls to an ephemeral-port/mkdtemp version of this function
// would compute two different ports and two different scratch directories —
// the worker would then health-check and seed against a port nothing is
// listening on. Fixed values make both imports agree by construction, and
// `prepareEnv` is idempotent (never wipes an existing scratch directory) so
// neither import's call disturbs whichever call the other one already made.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 47_610;
const SCRATCH_ROOT = join(tmpdir(), "plotroom-desktop-e2e");
const STATE_DIR = join(SCRATCH_ROOT, "state");
const WORKSPACE_DIR = join(STATE_DIR, "workspaces");
const REPO_DIR = join(SCRATCH_ROOT, "repo");

/** A minimal real git repository — the shell's spawned server refuses to start with none configured (`apps/server/src/config.ts`'s `WorkspaceConfig` doc comment). Idempotent: a no-op once `REPO_DIR/.git` exists. */
function ensureGitRepository() {
  if (existsSync(join(REPO_DIR, ".git"))) return;
  mkdirSync(REPO_DIR, { recursive: true });
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: REPO_DIR,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
  git("init", "--initial-branch", "main");
  git("config", "user.email", "desktop-e2e@plotroom.invalid");
  git("config", "user.name", "PlotRoom Desktop E2E");
  writeFileSync(join(REPO_DIR, "README.md"), "# fixture\n", "utf8");
  git("add", ".");
  git("commit", "-m", "initial");
}

/**
 * Builds the env this run's spawned server sidecar needs. Safe to call from
 * both the launcher and worker processes (see this file's header) — every
 * value is fixed, and directory creation is idempotent.
 */
export function prepareEnv() {
  mkdirSync(WORKSPACE_DIR, { recursive: true });
  ensureGitRepository();

  return {
    port: PORT,
    baseUrl: `http://127.0.0.1:${PORT}`,
    env: {
      PLOTROOM_HOST: "127.0.0.1",
      PLOTROOM_PORT: String(PORT),
      PLOTROOM_STATE_DIR: STATE_DIR,
      PLOTROOM_WORKSPACE_REPO: REPO_DIR,
      PLOTROOM_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  };
}

/** Polls `/api/health` until it answers, or throws — never a fixed sleep racing the sidecar's own startup. */
export async function waitForHealth(baseUrl, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    const { promise, resolve } = Promise.withResolvers();
    setTimeout(resolve, 150);
    await promise;
  }
  throw new Error(`server at ${baseUrl} never became healthy`);
}

/** A same-origin, loopback-trusted POST — this suite's own seeding, same shape #308's S1 spike used. */
async function apiPost(baseUrl, path, body) {
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
  return response.json();
}

/** Seeds one ticket + one content node — the fixture the canvas-visible/drag/wheel smoke drives. */
export async function seedTicketNode(baseUrl, title) {
  const object = await apiPost(baseUrl, "/api/objects", {
    kind: "ticket",
    title,
    renderings: { card: {}, summary: title, agentContent: title },
  });
  const node = await apiPost(baseUrl, "/api/nodes", {
    role: "content",
    refId: object.object.id,
  });
  return { objectId: object.object.id, nodeId: node.node.id };
}

/**
 * Spawns a *second*, independent copy of the same debug binary, pointed at
 * the same host/port as the WDIO-managed instance. In practice
 * `tauri_plugin_single_instance` intercepts this before it ever reaches
 * `setup()`'s spawn-or-attach call (confirmed empirically: the second
 * process produces no log output at all and exits quickly) — this
 * harness's caller checks the *observable* invariant that matters either
 * way (never two server sidecars), not this process's own output.
 */
export function spawnSecondInstance(binaryPath, env) {
  const child = spawn(binaryPath, [], {
    env: { ...process.env, ...env, RUST_LOG: "info" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const { promise, resolve } = Promise.withResolvers();
  setTimeout(resolve, 3_000);
  return promise.then(() => {
    child.kill("SIGKILL");
    return output;
  });
}

/**
 * #351: neither `browser.closeWindow()`, a native `Cmd+W` key event, nor
 * `window.close()` reliably reaches `lib.rs`'s `on_window_event` ->
 * `CloseRequested` -> `spawner.shutdown()` path via
 * `@wdio/tauri-service`'s embedded WebDriver provider on macOS (confirmed
 * empirically, filed as #351 -- a real gap in the shell's own teardown
 * path, not something this test suite can fix). This is the suite's own
 * safety net: whatever the graceful path did or didn't do, nothing stays
 * bound to this run's port once the session that owned it has ended.
 * Returns whether it actually had to kill anything.
 */
export function killPortHolder(port) {
  try {
    if (process.platform === "win32") {
      const output = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess`,
        ],
        { encoding: "utf8" },
      ).trim();
      const pids = output.split(/\s+/).filter(Boolean);
      for (const pid of pids)
        execFileSync("taskkill", ["/PID", pid, "/F", "/T"]);
      return pids.length > 0;
    }
    const output = execFileSync("lsof", ["-ti", `:${port}`], {
      encoding: "utf8",
    }).trim();
    const pids = output.split(/\s+/).filter(Boolean);
    for (const pid of pids) process.kill(Number(pid), "SIGKILL");
    return pids.length > 0;
  } catch {
    // `lsof`/`Get-NetTCPConnection` exit non-zero (or print nothing) when
    // nothing is listening -- the common, healthy case.
    return false;
  }
}
