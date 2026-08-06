// Spike-only harness (never touches apps/desktop production code, spike
// throwaway dir per epic #304's track partition). Spawns a real
// @plotroom/server against the already-built apps/web/dist and
// apps/server/dist, seeds one canvas node through the same API surface
// electrobun-shell.spec.ts (0006's spike) uses, then holds the process open
// so a Tauri window can point at a real, running PlotRoom server the same
// way production would (single origin, spec §12).
//
// IMPORTANT: the server child MUST be spawned with the system `node`, never
// `process.execPath` under this harness's own runtime. Running
// apps/server/dist/index.js directly under Bun crashes immediately with a
// NAPI fatal error (a native N-API dependency the compiled server pulls in
// is not yet Bun-compatible) - confirmed empirically during this spike, see
// the #308 evidence comment. #314 (server-on-bun) is a separate, deliberate
// migration; this harness is not that.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_ENTRY = fileURLToPath(
  new URL("../../apps/server/dist/index.js", import.meta.url),
);
const WEB_DIST = fileURLToPath(new URL("../../apps/web/dist", import.meta.url));

// Fixed by default (tauri.conf.json's build.devUrl is static config, not
// wired to this harness) - override with SPIKE_SERVER_PORT if 47811 is busy.
const PORT = process.env.SPIKE_SERVER_PORT
  ? Number(process.env.SPIKE_SERVER_PORT)
  : 47811;
const baseUrl = `http://127.0.0.1:${PORT}`;

const scratch = [];
const repoDir = mkdtempSync(join(tmpdir(), "plotroom-spike-repo-"));
scratch.push(repoDir);
const git = (...args) =>
  execFileSync("git", args, {
    cwd: repoDir,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
git("init", "--initial-branch", "main");
git("config", "user.email", "spike@plotroom.invalid");
git("config", "user.name", "PlotRoom Spike");
writeFileSync(join(repoDir, "README.md"), "# fixture\n", "utf8");
git("add", ".");
git("commit", "-m", "initial");

const stateDir = mkdtempSync(join(tmpdir(), "plotroom-spike-state-"));
scratch.push(stateDir);
const workspaceDir = join(stateDir, "workspaces");
mkdirSync(workspaceDir, { recursive: true });

const child = spawn("node", [SERVER_ENTRY], {
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    PLOTROOM_PORT: String(PORT),
    PLOTROOM_STATE_DIR: stateDir,
    PLOTROOM_STATIC_DIR: WEB_DIST,
    PLOTROOM_LOG_LEVEL: "error",
    PLOTROOM_RUNTIME: "scripted",
    PLOTROOM_WORKSPACE_REPO: repoDir,
    PLOTROOM_WORKSPACE_DIR: workspaceDir,
  },
});
child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server on port ${PORT} never became healthy`);
}
await waitForHealth();

async function apiPost(path, body) {
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

const object = await apiPost("/api/objects", {
  kind: "ticket",
  title: "Tauri shell spike ticket",
  renderings: {
    card: {},
    summary: "Tauri shell spike ticket",
    agentContent: "context for the Tauri shell spike",
  },
});
const node = await apiPost("/api/nodes", {
  role: "content",
  refId: object.object.id,
});

console.log(
  `SPIKE_SERVER_READY port=${PORT} baseUrl=${baseUrl} nodeId=${node.node.id}`,
);

function cleanup() {
  child.kill();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
}
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
child.on("exit", (code) => {
  console.log(`SPIKE_SERVER_CHILD_EXIT code=${code}`);
});
