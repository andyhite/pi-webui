import { mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Produce the server as one standalone per-platform binary (issue #316).
 *
 * A packaged desktop ships no Bun and no `node_modules` for the sidecar: it
 * ships this artifact, spawned by the Tauri shell as `bundle.externalBin`.
 * Unlike `apps/session-host/src/compile.ts`'s sidecar, the server carries no
 * native addon of its own to stage beside the binary — `bun:sqlite` is built
 * into the Bun runtime the compiled binary embeds, not a `.node` file this
 * process would otherwise have to find and copy. Compilation is native-only
 * for the same reason session-host's is: this produces a binary for the
 * platform this machine actually is, not a cross-compiled guess.
 */

export const OUT_DIR = "out";

export const BINARY_NAME =
  process.platform === "win32" ? "plotroom-server.exe" : "plotroom-server";

export class ServerCompileError extends Error {}

const MEGABYTE = 1_000_000;

/** Long enough for a cold compiled binary on a contended runner, short enough
 * to fail (mirrors `apps/session-host/src/compile.ts`'s own `START_TIMEOUT_MS`
 * — the CI Windows runner did not answer within the previous 20s bound). */
const START_TIMEOUT_MS = 120_000;

/**
 * Did the compiled artifact actually start and answer its own health route?
 * A green build that produced a binary which cannot boot is a failure this
 * check turns into a loud one at compile time rather than a mystery at
 * packaging time.
 */
export async function smokeTest(binary: string): Promise<void> {
  const port = await freePort();
  // `mktemp` (a Unix shell command `Bun.$` previously ran here) does not
  // exist on a Windows runner's default shell -- `mkdtempSync`, a Node API,
  // works identically on every platform Bun targets.
  const stateDir = mkdtempSync(join(tmpdir(), "plotroom-server-smoke-"));
  const child = Bun.spawn([binary], {
    env: {
      ...environment(),
      PLOTROOM_PORT: String(port),
      PLOTROOM_STATE_DIR: stateDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Drained from the start, not after the race: a child that filled the pipe
  // buffer would block on its own write and never answer the health check.
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();

  // A child that already exited will never suddenly start answering health
  // checks — tracked so the poll below fails fast on a binary that cannot
  // start, rather than spending the full deadline on a dead process (the
  // same class of check as `apps/session-host/src/compile.ts`'s `running`
  // race).
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });

  try {
    const deadline = Date.now() + START_TIMEOUT_MS;
    let healthy = false;
    while (Date.now() < deadline && !exited) {
      try {
        const res = await fetch(`http://127.0.0.1:${String(port)}/api/health`);
        if (res.ok) {
          healthy = true;
          break;
        }
      } catch {
        // Not listening yet — retry until the deadline.
      }
      // Executor form: the workspace's `lib` targets ES2023
      // (`tsconfig.json`), which predates `Promise.withResolvers` — see
      // `src/runtime/omp.ts`'s own note on the same tradeoff.
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!healthy) {
      child.kill();
      const [out, err] = await Promise.all([stdout, stderr]);
      const reason = exited
        ? `the compiled server exited before answering /api/health (code ${String(child.exitCode)})`
        : `the compiled server never answered /api/health within ${String(START_TIMEOUT_MS / 1000)}s on port ${String(port)}`;
      throw new ServerCompileError(
        `${reason}\nstdout: ${out.trim() || "(empty)"}\nstderr: ${err.trim() || "(empty)"}`,
      );
    }
  } finally {
    child.kill();
    await child.exited;
  }
}

/** `Bun.spawn` rejects the `undefined` slots `process.env` can carry. */
function environment(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

async function freePort(): Promise<number> {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const { port } = server;
  server.stop(true);
  return port;
}

async function compile(): Promise<void> {
  const packageDir = join(import.meta.dir, "..");
  const outDir = join(packageDir, OUT_DIR);
  const binary = join(outDir, BINARY_NAME);
  mkdirSync(outDir, { recursive: true });

  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "compiled-entrypoint.ts")],
    compile: {
      outfile: binary,
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
    },
    throw: false,
  });
  if (!built.success) {
    throw new ServerCompileError(
      `compiling the server failed:\n${built.logs.map(String).join("\n")}`,
    );
  }

  await smokeTest(binary);

  process.stdout.write(
    `server compiled for ${process.platform}-${process.arch}\n  ${binary} (${Math.round(statSync(binary).size / MEGABYTE).toString()}MB)\n`,
  );
}

// Guarded so importing the helpers above for a test does not recompile a
// multi-hundred-megabyte artifact on every test run.
if (import.meta.main) await compile();
