import { defineConfig, devices } from "@playwright/test";

/**
 * The W10 milestone gate (Epic 5.1/5.5, Batch 2 Stage 2): a real, spawned
 * `@plotroom/server` child process, a real local git repository as the
 * workstream's repo, and a real browser tab loaded from the server's own
 * served page (single origin, spec §12) — never the Vite dev server.
 *
 * Requires `turbo run build --filter=@plotroom/web` first: this suite serves
 * `apps/web/dist`, which does not exist until built (#315: `apps/server` no
 * longer builds — the spawned server entry is `apps/server/src/index.ts`
 * directly, via `bun`). See `apps/web/e2e/milestone.spec.ts`'s doc comment
 * for the exact command and what the gate proves.
 *
 * Deliberately not wired into `bun run verify` or turbo's `test` task: spawning
 * a real server/git repo/browser is slow and this is one hermetic gate, not
 * a broad suite — run it explicitly via `bun run --filter=@plotroom/web e2e`
 * (or `e2e:browsers` for the `webkit`/`firefox` projects below).
 *
 * #317: browser engine matrix. `chromium` is the per-PR gate (unchanged
 * behavior and timing — `package.json`'s `e2e` script pins `--project=chromium`
 * explicitly so adding the other two projects here never changes what a PR
 * run executes). `webkit` and `firefox` run only on `main`/nightly via the
 * separate `e2e:browsers` script, invoked by its own CI job
 * (`.github/workflows/ci.yml`'s `e2e-browser-matrix`).
 *
 * **`webkit` is a standards proxy, not engine identity.** Playwright ships a
 * patched WebKit-*main* build (its own nightly-ish branch, not a release
 * WebKit tied to any shipping Safari/WKWebView), so a green `webkit` project
 * here says "the canvas holds up against WebKit's current engine direction,"
 * never "this is what macOS's real WKWebView does" — WKWebView on a given
 * macOS release ships an older, vendor-patched WebKit snapshot. That gap is
 * exactly why `apps/desktop/e2e` (Layer 2, #317) exists: its per-OS
 * canvas-visible + drag/wheel smoke drives the *actual* WebKitGTK/WKWebView/
 * WebView2 each platform ships, closing what this matrix cannot.
 */
export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // One server/repo per test file's `beforeAll`; running files in parallel
  // would spawn several servers on their own ephemeral ports at once, which
  // is fine, but there is exactly one gate here, so serial keeps it simple
  // and avoids any chance of port collision under `ephemeralPort()`.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    headless: true,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
});
