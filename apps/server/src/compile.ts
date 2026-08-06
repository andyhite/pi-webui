import { mkdirSync, statSync } from "node:fs";
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

/**
 * Did the compiled artifact actually start and answer its own health route?
 * A green build that produced a binary which cannot boot is a failure this
 * check turns into a loud one at compile time rather than a mystery at
 * packaging time.
 */
export async function smokeTest(binary: string): Promise<void> {
  const port = await freePort();
  const stateDir = (await Bun.$`mktemp -d`.text()).trim();
  const child = Bun.spawn([binary], {
    env: {
      ...environment(),
      PLOTROOM_PORT: String(port),
      PLOTROOM_STATE_DIR: stateDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    const deadline = Date.now() + 20_000;
    let healthy = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${String(port)}/api/health`);
        if (res.ok) {
          healthy = true;
          break;
        }
      } catch {
        // Not listening yet — retry until the deadline.
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!healthy) {
      throw new ServerCompileError(
        `the compiled server never answered /api/health within 20s on port ${String(port)}`,
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
    entrypoints: [join(import.meta.dir, "index.ts")],
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
