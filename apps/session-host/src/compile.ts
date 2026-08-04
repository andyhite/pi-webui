import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { WORKER_SELECTOR_PREFIX } from "./worker-dispatch.js";

/**
 * Produce the session host as one standalone per-platform binary (issue #93,
 * decided in #92).
 *
 * A packaged PlotRoom ships no Bun and no `node_modules` for the sidecar: it
 * ships this artifact, and `PLOTROOM_SESSION_HOST` points at it. Compilation is
 * **native only** — Bun can cross-compile, but the addon staged below cannot be
 * had for a platform this machine did not install, so a cross-compiled binary
 * would be one missing the half that does the work. One runner per platform is
 * the constraint, not a preference.
 *
 * Three things a bare `bun build --compile src/main.ts` gets wrong. The first
 * fails loudly; the other two hand you a binary, which is why they are handled
 * here and not in a CI shell line:
 *
 *  1. **The legacy-Pi module registry does not resolve.** The SDK's legacy
 *     extension shim imports {@link LEGACY_PI_MODULES}, a specifier that exists
 *     only inside the SDK's own build plugin, so bundling PlotRoom's entry fails
 *     outright. It is externalized rather than supplied: PlotRoom disables
 *     extension discovery and loads no legacy Pi extension, so nothing reaches
 *     the import. Both distributions reject on that path, though not
 *     identically — under a host Bun the shim short-circuits before importing
 *     ("bundled modules are only available in compiled mode"), while compiled it
 *     attempts the import and fails to resolve it. Same unreachable path, two
 *     rejections, and the difference is the `isCompiledBinary()` flip that (3)
 *     is entirely about.
 *  2. **The native addon does not survive compilation.** `pi_natives` is
 *     `require`d at runtime from a computed path, so the bundler never sees it,
 *     and the SDK's embedded-addon table is `null` in the published package —
 *     only its own release build fills it in. The loader's compiled-binary
 *     search includes the executable's own directory, so the addon is staged
 *     there beside the binary. The artifact is therefore a **directory**, not a
 *     lone file, and a compile that produced no addon is a failure
 *     ({@link stageNativeAddon} refuses) rather than a binary that dies on its
 *     first launch with a resolution error.
 *  3. **The binary becomes the runtime's worker host.** Compiled, the SDK
 *     re-execs `process.execPath` for the subprocesses its tools need, so the
 *     session host must dispatch those launches instead of refusing them as
 *     unknown arguments — see `worker-dispatch.ts`.
 *
 * The compile then runs what it built ({@link smokeTest}) before reporting
 * success, because each of (2) and (3) is a failure a green build step hides:
 * the binary exists, and a session on it is broken. The check belongs to the
 * verb that produces the artifact rather than to the workflow that calls it, so
 * a release build and a compile on a laptop are held to it too.
 */

/** The SDK's build-plugin-only specifier; see (1) above. */
export const LEGACY_PI_MODULES = "omp-legacy-pi-modules";

/** Where the artifact lands. Not `dist/`: that is `tsc -b`'s, and turbo caches it. */
export const OUT_DIR = "out";

export class SessionHostCompileError extends Error {}

/**
 * The artifact's name and directory — what a packaged install points
 * `PLOTROOM_SESSION_HOST` at. Exported through the package (`./compile`) so the
 * installer staging reads them instead of restating them; Windows needs the
 * extension to be executable at all.
 */
export const BINARY_NAME =
  process.platform === "win32"
    ? "plotroom-session-host.exe"
    : "plotroom-session-host";

/**
 * The addon files to put beside the binary: every `.node` the platform package
 * ships, because which one loads is the running CPU's choice (x64 publishes a
 * baseline build for hosts without AVX2), not the compiler's.
 */
export function addonFilesIn(directory: string): string[] {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".node"))
    .sort();
  if (files.length === 0) {
    throw new SessionHostCompileError(
      `no native addon in ${directory}: the compiled session host would fail to load one`,
    );
  }
  return files;
}

/**
 * Copy the addon beside the binary, and say what was staged.
 *
 * Resolved **through the SDK's own dependency graph** rather than from a
 * dependency of this package: under pnpm neither `@oh-my-pi/pi-natives` nor its
 * platform leaf is reachable from here, and declaring one would pin a second
 * version of the addon. The loader validates a version sentinel in the `.node`
 * against the SDK's own `pi-natives` version, so an addon from any version but
 * that one is refused at load — asking the SDK where its natives are is what
 * makes them the same version by construction.
 */
export function stageNativeAddon(outDir: string): string[] {
  const tag = `${process.platform}-${process.arch}`;
  const sdk = Bun.resolveSync("@oh-my-pi/pi-coding-agent", import.meta.dir);
  const natives = Bun.resolveSync("@oh-my-pi/pi-natives", dirname(sdk));
  let addonDir;
  try {
    addonDir = dirname(
      Bun.resolveSync(
        `@oh-my-pi/pi-natives-${tag}/package.json`,
        dirname(natives),
      ),
    );
  } catch {
    // Which platforms have an addon is the SDK's `pi-natives` optional
    // dependencies and nothing else's; a list here would be a third copy that
    // refuses a host the SDK supports the day it gains one. The refusal is
    // named rather than a resolver stack, which is all the list was for.
    throw new SessionHostCompileError(
      `the session runtime publishes no native addon for ${tag}, ` +
        `so a compiled session host cannot load one here: compile on a platform it supports`,
    );
  }

  const staged: string[] = [];
  for (const file of addonFilesIn(addonDir)) {
    const from = join(addonDir, file);
    const to = join(outDir, file);
    // ~155MB apiece; a re-compile in the same tree should not copy them again.
    const present = statSync(to, { throwIfNoEntry: false });
    if (present?.size !== statSync(from).size) copyFileSync(from, to);
    staged.push(file);
  }
  return staged;
}

/** A launch of the artifact, as the checks below read it. */
export interface SmokeLaunch {
  /**
   * Was it still running when the probe's bound elapsed? Carried as its own fact
   * rather than inferred from the exit code: a killed child and a child that
   * died on a signal both report no code, and reading one as the other would
   * pass a worker that crashed in its first moments.
   */
  readonly running: boolean;
  /** `null` when it left on a signal — its own or the probe's kill. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Did the artifact start? PlotRoom's parser refusing an unknown argument is the
 * cheapest proof — the binary ran, the SDK's module graph loaded, the native
 * addon resolved, our own code decided, and a frame reached stdout and was
 * flushed — and it needs no credentials, model or workspace.
 */
export function startedAndRefused(launch: SmokeLaunch): boolean {
  return (
    !launch.running &&
    launch.code === 2 &&
    firstFrame(launch.stdout)?.type === "fatal"
  );
}

/**
 * Did a worker launch reach the worker instead of the session parser?
 *
 * Compilation is what makes the SDK re-exec this binary for the subprocesses its
 * tools need, so this is the one defect a compiled artifact can have and a
 * host-Bun run cannot (`worker-dispatch.ts`). A dispatched worker **does not
 * exit**: it waits for the IPC peer the probe deliberately does not give it, so
 * still running at the bound is the pass — and the check is that rather than the
 * absence of the parser's sentence, because every way this can go wrong ends the
 * process early. The parser refusing exits 2, an unknown selector exits 1 from
 * the SDK's own dispatcher, a handover that leaves through `process.exit` exits 0
 * with nothing on stdout at all, and a worker that crashes leaves on a signal.
 */
export function dispatchedTheWorker(launch: SmokeLaunch): boolean {
  return launch.running;
}

/** Long enough for a cold 124MB binary on a contended runner, short enough to fail. */
const START_TIMEOUT_MS = 120_000;

/**
 * The worker probe's bound. A *healthy* dispatch does not exit: the worker waits
 * for the IPC peer this launch deliberately does not give it, so being alive at
 * the bound is the pass. The failure it looks for — the session parser answering
 * a worker launch — happens in the first moments, and the launch before this one
 * has already paid for the cold start.
 */
const WORKER_PROBE_MS = 15_000;

/**
 * Run the artifact twice: once as a session launch it must refuse, once as the
 * worker the runtime will re-exec it as.
 *
 * Both launches get a **throwaway home**. The loader searches `~/.omp/natives/`
 * and the platform user-data directory *before* the executable's own directory,
 * so on any machine that has run omp's own compiled binary this check would pass
 * for an artifact with nothing staged beside it — green here, broken on the
 * operator's machine. Isolating the home leaves the staged copy as the only
 * candidate that can satisfy the load.
 */
export async function smokeTest(binary: string): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "plotroom-session-host-smoke-"));
  try {
    const session = await launch(binary, ["--not-a-session-host-flag"], home);
    if (!startedAndRefused(session)) {
      throw new SessionHostCompileError(
        `the compiled session host did not start${describe(session)}`,
      );
    }

    const worker = await launch(
      binary,
      [`${WORKER_SELECTOR_PREFIX}js_eval_process`],
      home,
      WORKER_PROBE_MS,
    );
    if (!dispatchedTheWorker(worker)) {
      throw new SessionHostCompileError(
        `the compiled session host did not hold the runtime's own worker launch, ` +
          `so a session on it loses every tool that needs a subprocess${describe(worker)}`,
      );
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

async function launch(
  binary: string,
  args: readonly string[],
  home: string,
  bound: number = START_TIMEOUT_MS,
): Promise<SmokeLaunch> {
  const child = Bun.spawn([binary, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...environment(),
      HOME: home,
      USERPROFILE: home,
      XDG_DATA_HOME: join(home, "share"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
    },
  });

  // Drained from the start, not after the race: a child that filled the pipe
  // buffer would block on its own write, never exit, and be reported as still
  // running — the one answer that means health here.
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();

  // The bound is timed here rather than handed to `Bun.spawn` because a killed
  // child's exit code is the platform's business (143 here, something else on
  // Windows); reading one as "was it still running?" would make the answer depend
  // on where the compile ran. A binary that hangs at module init is one of the
  // failures this check exists to catch, so the bound itself is not optional.
  let timer: Timer | undefined;
  const running = await Promise.race([
    child.exited.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        resolve(true);
      }, bound);
    }),
  ]);
  clearTimeout(timer);
  if (running) child.kill();

  const [out, err] = await Promise.all([stdout, stderr]);
  await child.exited;
  return { running, code: child.exitCode, stdout: out, stderr: err };
}

/** `Bun.spawn` rejects the `undefined` slots `process.env` can carry. */
function environment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function describe(launch: SmokeLaunch): string {
  const outcome = launch.running
    ? "still running at the bound"
    : `exit ${launch.code === null ? "on a signal" : launch.code.toString()}`;
  return (
    `: ${outcome}\n` +
    `stdout: ${launch.stdout.trim() || "(empty)"}\n` +
    `stderr: ${launch.stderr.trim() || "(empty)"}`
  );
}

function firstFrame(stdout: string): { type?: string } | null {
  const line = stdout.split("\n", 1)[0];
  if (line === undefined || line.length === 0) return null;
  try {
    const frame: unknown = JSON.parse(line);
    return typeof frame === "object" && frame !== null
      ? (frame as { type?: string })
      : null;
  } catch {
    return null;
  }
}

const MEGABYTE = 1_000_000;

async function compile(): Promise<void> {
  const packageDir = join(import.meta.dir, "..");
  const outDir = join(packageDir, OUT_DIR);
  const binary = join(outDir, BINARY_NAME);
  mkdirSync(outDir, { recursive: true });

  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "main.ts")],
    external: [LEGACY_PI_MODULES],
    compile: {
      outfile: binary,
      // The session host runs inside the agent's own workspace, and every one of
      // these would read that workspace's configuration as if it were PlotRoom's:
      // a `.env` there would reach this process's environment, and a `bunfig.toml`
      // could preload code into it. Same stance as the pinned skills and rules in
      // `main.ts` — nothing ambient, nothing PlotRoom did not assemble.
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
    },
    throw: false,
  });
  if (!built.success) {
    throw new SessionHostCompileError(
      `compiling the session host failed:\n${built.logs.map(String).join("\n")}`,
    );
  }

  const staged = stageNativeAddon(outDir);
  await smokeTest(binary);

  const report = [binary, ...staged.map((file) => join(outDir, file))]
    .map(
      (file) =>
        `  ${file} (${Math.round(statSync(file).size / MEGABYTE).toString()}MB)`,
    )
    .join("\n");
  process.stdout.write(
    `session host compiled for ${process.platform}-${process.arch}\n${report}\n`,
  );
}

// Guarded because the helpers above are unit-tested: an unguarded top-level call
// would compile a 400MB artifact every time `bun test src` loaded this file.
if (import.meta.main) await compile();
