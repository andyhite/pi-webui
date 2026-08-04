/**
 * Builds and drives a minimal Electrobun app for the #84 spike: can the
 * Playwright canvas e2e suite drive an Electrobun window?
 *
 * The answer, and every constraint behind it, is recorded in
 * `docs/decisions/0006-electrobun-under-playwright.md`. This file is the
 * runnable half of that record, so the post-M1 revisit of #78(c) re-runs it
 * rather than re-deriving it. It is deliberately outside the default e2e
 * gate (see `playwright.electrobun.config.ts`).
 *
 * Three facts shape the whole harness. Each was **measured** on Linux x64
 * against Electrobun 1.18.1; where a mechanism is named it comes from
 * reading Electrobun's source, and it is there to explain the measurement
 * rather than to stand in for one.
 *
 *   1. CDP exists only under `bundleCEF`. Measured: with the system webview
 *      (WebKitGTK) no remote endpoint is reachable, and with CEF one is. The
 *      Linux CEF path does not set `CefSettings.remote_debugging_port` at
 *      all; the port arrives as a plain Chromium switch out of
 *      `build.linux.chromiumFlags`.
 *   2. The launcher discards its own argv. Measured: with the port in the
 *      config the app prints its `DevTools listening on …` banner, and with
 *      the port only on `./bin/launcher`'s command line no endpoint ever
 *      opens. The mechanism, per Electrobun's source, is that the Zig
 *      entrypoint spawns a fixed `{bun, Resources/main.js}` child and Linux
 *      CEF reads its command line back out of `/proc/self/cmdline` — the bun
 *      child's. So the port has to reach the app as data, which is why this
 *      harness writes it into the config the build turns into
 *      `Resources/build.json`.
 *   3. Linux CEF requires X11. Measured only in that every run here is under
 *      `xvfb-run`; per the source, `initializeGTK()` forces
 *      `GDK_BACKEND=x11` and calls the aborting `gtk_init`, and CEF is given
 *      `--ozone-platform=x11 --use-x11`. There is no headless mode to fall
 *      back on because CEF is embedded in-process rather than spawned.
 *
 * Electrobun is fetched into a scratch directory at run time instead of
 * being added to the workspace: #78 deferred the shell past M1, and a
 * dependency on a shell we have not adopted would be a standing claim we
 * had. The scratch directory is reused across runs because the framework
 * pulls ~210MB of CLI, core and CEF tarballs on first build, expanding to
 * roughly 1.6GB on disk.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Browser, type Page } from "@playwright/test";

/**
 * Pinned, because this spike's answer is only true of a version.
 *
 * 1.18.1 is npm `latest` as of 2026-08-04. Per its repository's later
 * source — read, not run — the beta line (1.18.4-beta.19) already changes
 * the mechanism: it routes the flag through `CefSettings` after validation,
 * refuses to forward it as a raw switch, adds an
 * `ELECTROBUN_CEF_REMOTE_DEBUGGING_PORT` runtime override, and turns the
 * port off by default in packaged builds. A green run on that line would
 * therefore be evidence about a different seam than the one the decision
 * record describes, so {@link startElectrobunShell} reinstalls whenever the
 * scratch directory holds a version other than this one.
 */
export const ELECTROBUN_VERSION = "1.18.1";

const APP_NAME = "PlotRoomShellSpike";

/** Every identifier this harness ever mints starts with this. */
const IDENTIFIER_PREFIX = "dev.plotroom.shell-spike";

/**
 * Where Electrobun puts a CEF profile: observed at
 * `~/.cache/<identifier>/<channel>/CEF`, so one directory per identifier is
 * this harness's to remove.
 */
const CACHE_ROOT = join(homedir(), ".cache");

/** Reused across runs: a cold scratch directory costs ~210MB and ~1.6GB. */
const SCRATCH_ROOT =
  process.env.PLOTROOM_ELECTROBUN_SPIKE_DIR ??
  join(tmpdir(), "plotroom-electrobun-spike");

/**
 * `electrobun.config.ts`, written per run because the CDP port and the
 * identifier are per-run. `defaultRenderer: "cef"` matters as much as
 * `bundleCEF` — bundling CEF without it still opens the window on
 * WebKitGTK, which has no CDP.
 */
function configSource(port: number, identifier: string): string {
  return `import type { ElectrobunConfig } from "electrobun";

const config: ElectrobunConfig = {
  app: {
    name: ${JSON.stringify(APP_NAME)},
    identifier: ${JSON.stringify(identifier)},
    version: "0.0.1",
  },
  build: {
    bun: { entrypoint: "src/bun/index.ts" },
    linux: {
      bundleCEF: true,
      defaultRenderer: "cef",
      chromiumFlags: {
        "remote-debugging-port": ${JSON.stringify(String(port))},
        // Electrobun's own Linux CEF defaults include
        // --disable-web-security, which changes page semantics under
        // test. \`false\` cancels a default flag, so this run is evidence
        // about the configuration a real suite would use rather than
        // about a browser with the same-origin policy switched off.
        "disable-web-security": false,
      },
    },
  },
};

export default config;
`;
}

/**
 * The whole app: one window pointed at the URL the harness passes in. The
 * renderer is PlotRoom's own served page, so nothing about the UI is
 * special-cased for this shell — which is the point of the spike.
 */
const ENTRYPOINT_SOURCE = `import { BrowserWindow } from "electrobun/bun";

new BrowserWindow({
  title: "PlotRoom (Electrobun spike)",
  url: process.env.PLOTROOM_SPIKE_URL ?? "about:blank",
  renderer: "cef",
  frame: { x: 0, y: 0, width: 1600, height: 1000 },
});
`;

/**
 * `Promise.withResolvers` would read better here and in
 * {@link awaitDevToolsEndpoint}, but the workspace targets ES2023
 * (`tsconfig.base.json`) where it does not exist, and raising the target
 * for a spike's readability is not this change's business. The executor
 * form is also what `server-harness.ts` beside this file already uses.
 *
 * `timeoutMs` is not belt-and-braces on top of Playwright's own timeout:
 * without it, a test timeout firing mid-build abandons the awaited promise
 * and leaves the build child writing into the shared scratch directory, so
 * the next run builds on top of a half-written bundle. Bounding the child
 * here means it ends itself either way.
 */
function run(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: "pipe" });
    let output = "";
    const collect = (chunk: Buffer) => (output += chunk.toString());
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `${command} ${args.join(" ")} did not finish within ${timeoutMs}ms and was killed\n--- output ---\n${output}`,
        ),
      );
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} exited ${code}\n--- output ---\n${output}`,
          ),
        );
    });
  });
}

/** Whether this host can run the spike at all, and if not, exactly why. */
export function unsupportedReason(): string | undefined {
  // x64 as well as linux: the bundle path this harness reads back is
  // `build/dev-linux-x64/…`, and on arm64 the CLI writes `dev-linux-arm64`,
  // so without the arch here the leg would download the framework, build,
  // and then fail on a missing file rather than skip with a reason.
  if (process.platform !== "linux" || process.arch !== "x64") {
    return `this leg is written against Electrobun's Linux x64 CEF path (X11 plus build.json flags); this host is ${process.platform}/${process.arch}`;
  }
  for (const binary of ["bun", "xvfb-run"]) {
    // `spawnSync` reports a missing executable as `error`, never as a
    // thrown exception, so an absent binary must be read off the result.
    if (spawnSync(binary, ["--version"]).error !== undefined) {
      return `\`${binary}\` is not on PATH; the spike builds with bun and needs an X display`;
    }
  }
  return undefined;
}

export interface ElectrobunShell {
  /** The Electrobun window's page, reached over CDP. */
  readonly page: Page;
  /** What the attached browser reports for itself. */
  readonly browserVersion: string;
  /**
   * The Chromium version the *bundle* carries, parsed out of the
   * `cefVersion` the build recorded. A run compares the two, so a future
   * CEF bump keeps the check honest instead of dating it.
   */
  readonly bundledChromiumVersion: string;
  /** The port CDP actually came up on, as read from CEF's own banner. */
  readonly cdpPort: number;
  stop(): Promise<void>;
}

/**
 * Waits for CEF's own DevTools banner on the app's combined output.
 *
 * The match requires the line terminator CEF prints: a pipe read can split
 * mid-URL, and `\S+` alone would happily resolve with a truncated endpoint,
 * which then fails as "the CDP seam moved" rather than "the banner was
 * split". The listeners stay attached afterwards, because detaching would
 * stop draining the pipes and eventually stall CEF — only a tail is kept,
 * since nothing reads the buffer again once the endpoint is found.
 */
function awaitDevToolsEndpoint(child: ChildProcess): Promise<string> {
  const RETAINED_OUTPUT_BYTES = 64 * 1024;
  return new Promise((resolve, reject) => {
    let log = "";
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Electrobun opened no DevTools endpoint within 60s.\n--- app output (tail) ---\n${log}`,
          ),
        ),
      60_000,
    );
    const onChunk = (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-RETAINED_OUTPUT_BYTES);
      const endpoint = log.match(
        /DevTools listening on (ws:\/\/\S+)\r?\n/,
      )?.[1];
      if (endpoint !== undefined) {
        clearTimeout(timer);
        resolve(endpoint);
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Electrobun exited ${code} before opening DevTools.\n--- app output (tail) ---\n${log}`,
        ),
      );
    });
  });
}

/** The version already in the scratch directory, if any. */
function installedVersion(root: string): string | undefined {
  const manifest = join(root, "node_modules", "electrobun", "package.json");
  if (!existsSync(manifest)) return undefined;
  try {
    // Narrowed rather than asserted: this file is whatever is on disk, and
    // a manifest without a readable `version` must read as "unknown, so
    // reinstall" instead of as a string the compiler was told to expect.
    const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    if (parsed === null || typeof parsed !== "object") return undefined;
    if (!("version" in parsed)) return undefined;
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Profiles left by runs that crashed before `stop()` — swept on the way in,
 * because a run whose process is gone cannot clean up after itself and the
 * identifier is unique per run, so nothing live is ever named here.
 */
function sweepStaleCaches(liveIdentifier: string): void {
  let entries: readonly string[];
  try {
    entries = readdirSync(CACHE_ROOT);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(`${IDENTIFIER_PREFIX}.`)) continue;
    if (entry === liveIdentifier) continue;
    rmSync(join(CACHE_ROOT, entry), { recursive: true, force: true });
  }
}

/**
 * Installs (once per pinned version), builds, and launches the app, then
 * attaches Playwright to it. `url` is loaded by the window before this
 * resolves.
 */
export async function startElectrobunShell(
  url: string,
  port: number,
): Promise<ElectrobunShell> {
  const root = SCRATCH_ROOT;
  mkdirSync(join(root, "src", "bun"), { recursive: true });

  if (!existsSync(join(root, "package.json"))) {
    const manifest = {
      name: "plotroom-electrobun-spike",
      private: true,
      version: "0.0.0",
    };
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
  }
  // Keyed on the version, not on mere presence: the scratch directory
  // outlives a bump of `ELECTROBUN_VERSION`, and a presence check would let
  // "bump the pin and re-run" go green while measuring the old framework.
  if (installedVersion(root) !== ELECTROBUN_VERSION) {
    await run(
      "bun",
      ["add", `electrobun@${ELECTROBUN_VERSION}`],
      root,
      5 * 60_000,
    );
  }

  // This run's own app identity. CEF's singleton lock lives under the cache
  // path Electrobun derives from `app.identifier`, so two instances sharing
  // one do not both start: the second prints "Opening in existing browser
  // session", `CefInitialize` fails, and it exits — measured, and measured
  // again to be unaffected by a `user-data-dir` Chromium switch, which
  // Electrobun's own `root_cache_path` overrides. Distinct identifiers do
  // run concurrently (also measured).
  //
  // The pid is in it as well as the port because `ephemeralPort()` binds
  // port 0 and closes before the app binds it, so two concurrent
  // invocations can be handed the same free port and the port alone would
  // not tell them apart. It is also the lever a parallel suite would pull:
  // one bundle per worker, one identifier each.
  const identifier = `${IDENTIFIER_PREFIX}.${port}.${process.pid}`;
  sweepStaleCaches(identifier);

  writeFileSync(
    join(root, "electrobun.config.ts"),
    configSource(port, identifier),
    "utf8",
  );
  writeFileSync(
    join(root, "src", "bun", "index.ts"),
    ENTRYPOINT_SOURCE,
    "utf8",
  );

  // Cold, this downloads the core and CEF tarballs; warm it is under a
  // second, which is what makes a per-run port affordable at all.
  await run("./node_modules/.bin/electrobun", ["build"], root, 10 * 60_000);

  const bundle = join(root, "build", "dev-linux-x64", `${APP_NAME}-dev`);
  // The build is the only place the port could have been dropped, and a
  // silent drop would surface 60s later as "no DevTools banner" — so the
  // flag is read back out of the bundle it was supposed to land in.
  const buildJson = JSON.parse(
    readFileSync(join(bundle, "Resources", "build.json"), "utf8"),
  ) as {
    chromiumFlags?: Record<string, string | boolean>;
    cefVersion?: string;
  };
  const written = buildJson.chromiumFlags?.["remote-debugging-port"];
  if (written !== String(port)) {
    throw new Error(
      `electrobun build did not carry remote-debugging-port=${port} into Resources/build.json (got ${JSON.stringify(written)}); the CDP seam has moved`,
    );
  }
  // `cefVersion` looks like "147.0.10+gd58e84d+chromium-147.0.7727.118".
  const bundledChromiumVersion = buildJson.cefVersion?.match(
    /chromium-(\d+(?:\.\d+)*)/,
  )?.[1];
  if (bundledChromiumVersion === undefined) {
    throw new Error(
      `no chromium version in the bundle's cefVersion (${JSON.stringify(buildJson.cefVersion)}); a run could not then prove which engine it drove`,
    );
  }

  // `detached` so teardown can signal the whole tree: xvfb-run, the
  // launcher, the bun child, and CEF's helper processes are all in this
  // group, and killing only the leader leaves CEF holding the display and
  // the profile lock.
  const child = spawn("xvfb-run", ["-a", "./bin/launcher"], {
    cwd: bundle,
    detached: true,
    env: { ...process.env, PLOTROOM_SPIKE_URL: url },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // SIGTERM before SIGKILL, the shape `server-harness.ts`'s `killAndWait`
  // uses: `Xvfb` removes its `/tmp/.X<n>-lock` and socket on SIGTERM and
  // not on SIGKILL, and `xvfb-run`'s own cleanup trap needs the chance to
  // run — without the grace period every run litters `/tmp` and walks the
  // display number upward for the life of the machine.
  const killTree = async () => {
    if (child.pid === undefined) return;
    const signal = (name: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, name);
      } catch {
        // Already gone; nothing to reap.
      }
    };
    signal("SIGTERM");
    await new Promise((settle) => setTimeout(settle, 1_000));
    signal("SIGKILL");
    rmSync(join(CACHE_ROOT, identifier), { recursive: true, force: true });
  };

  let browser: Browser;
  try {
    const endpoint = await awaitDevToolsEndpoint(child);
    const cdpPort = Number(new URL(endpoint).port);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const pages = browser.contexts().flatMap((context) => context.pages());
    const page = pages[0];
    if (page === undefined) {
      await browser.close();
      throw new Error(
        `attached over CDP but the Electrobun window exposed no page (contexts=${browser.contexts().length})`,
      );
    }
    return {
      page,
      browserVersion: browser.version(),
      bundledChromiumVersion,
      cdpPort,
      stop: async () => {
        // Closing the CDP connection must not kill the app — `close()` on
        // a connectOverCDP browser detaches, and the tree is ours to end.
        await browser.close().catch(() => undefined);
        await killTree();
      },
    };
  } catch (error) {
    await killTree();
    throw error;
  }
}
