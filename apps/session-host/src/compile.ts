import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

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
 * Two things a bare `bun build --compile src/main.ts` gets wrong, both of which
 * produce a binary rather than an error, which is why they are handled here and
 * not in a CI shell line:
 *
 *  1. **The legacy-Pi module registry does not resolve.** The SDK's legacy
 *     extension shim imports {@link LEGACY_PI_MODULES}, a specifier that exists
 *     only inside the SDK's own build plugin, so bundling PlotRoom's entry fails
 *     outright. It is externalized rather than supplied: PlotRoom disables
 *     extension discovery and loads no legacy Pi extension, so the import is
 *     unreachable for us, and externalizing it leaves that path exactly as it
 *     already is when the session host runs under a host Bun — a rejected
 *     promise on a path nothing takes.
 *  2. **The native addon does not survive compilation.** `pi_natives` is
 *     `require`d at runtime from a computed path, so the bundler never sees it,
 *     and the SDK's embedded-addon table is `null` in the published package —
 *     only its own release build fills it in. The loader's compiled-binary
 *     search includes the executable's own directory, so the addon is staged
 *     there beside the binary. The artifact is therefore a **directory**, not a
 *     lone file, and a compile that produced no addon is a failure
 *     ({@link stageNativeAddon} refuses) rather than a binary that dies on its
 *     first launch with a resolution error.
 *
 * The compile then runs what it built ({@link smokeTest}) before reporting
 * success, because every failure above is one a green build step hides: the
 * binary exists, and it cannot start. The check belongs to the verb that
 * produces the artifact rather than to the workflow that calls it, so it also
 * holds for a release build and for a compile on a laptop.
 */

/** The SDK's build-plugin-only specifier; see (1) above. */
export const LEGACY_PI_MODULES = "omp-legacy-pi-modules";

/** Where the artifact lands. Not `dist/`: that is `tsc -b`'s, and turbo caches it. */
export const OUT_DIR = "out";

/**
 * The platforms the SDK publishes a native addon for. Named here so an
 * unsupported host is refused by name — a compile that skipped the addon
 * because there was none to copy is the failure this list exists to prevent.
 */
const NATIVE_ADDON_PLATFORMS: readonly string[] = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-x64",
];

export class SessionHostCompileError extends Error {}

/** The package holding this platform's `pi_natives` addon. */
export function nativeAddonPackage(platform: string, arch: string): string {
  const tag = `${platform}-${arch}`;
  if (!NATIVE_ADDON_PLATFORMS.includes(tag)) {
    throw new SessionHostCompileError(
      `the session runtime publishes no native addon for ${tag}: ` +
        `compile on one of ${NATIVE_ADDON_PLATFORMS.join(", ")}`,
    );
  }
  return `@oh-my-pi/pi-natives-${tag}`;
}

/**
 * The artifact's name — what a packaged install points `PLOTROOM_SESSION_HOST`
 * at, so the release wiring reads it here rather than restating it. Windows
 * needs the extension to be executable at all.
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
  const packageName = nativeAddonPackage(process.platform, process.arch);
  const sdk = Bun.resolveSync("@oh-my-pi/pi-coding-agent", import.meta.dir);
  const natives = Bun.resolveSync("@oh-my-pi/pi-natives", dirname(sdk));
  const addonDir = dirname(
    Bun.resolveSync(`${packageName}/package.json`, dirname(natives)),
  );

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

/**
 * Prove the artifact runs. An unknown argument is the cheapest launch that
 * exercises everything compilation can break — the binary starts, the SDK's
 * module graph loads, the native addon resolves, PlotRoom's own parser refuses,
 * and a frame reaches stdout and is flushed — while needing no credentials, no
 * model and no workspace.
 */
export async function smokeTest(binary: string): Promise<void> {
  const child = Bun.spawn([binary, "--not-a-session-host-flag"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  const refusal = firstFrame(stdout);
  if (code !== 2 || refusal?.type !== "fatal") {
    throw new SessionHostCompileError(
      `the compiled session host did not start: exit ${code.toString()}\n` +
        `stdout: ${stdout.trim() || "(empty)"}\n` +
        `stderr: ${stderr.trim() || "(empty)"}`,
    );
  }
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
