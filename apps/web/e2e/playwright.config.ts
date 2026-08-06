import { defineConfig } from "@playwright/test";

/**
 * The W10 milestone gate (Epic 5.1/5.5, Batch 2 Stage 2): a real, spawned
 * `@plotroom/server` child process, a real local git repository as the
 * workstream's repo, and a real Chromium tab loaded from the server's own
 * served page (single origin, spec §12) — never the Vite dev server.
 *
 * Requires `bun run build` first (root or `apps/web`/`apps/server` at minimum):
 * this suite spawns `apps/server/dist/index.js` and serves `apps/web/dist`,
 * neither of which exists until built. See `apps/web/e2e/milestone.spec.ts`'s
 * doc comment for the exact command and what the gate proves.
 *
 * Deliberately not wired into `bun run verify` or turbo's `test` task: spawning
 * a real server/git repo/browser is slow and this is one hermetic gate, not
 * a broad suite — run it explicitly via `bun run --filter=@plotroom/web e2e`.
 *
 * The #84 Electrobun shell spike is ignored here and lives on its own
 * config (`playwright.electrobun.config.ts`): it drives a shell the stack
 * has not adopted, needs `bun` and an X display, and on a cold run
 * downloads ~210MB of CEF into ~1.6GB of scratch space — none of which
 * this gate should ever depend on.
 */
export default defineConfig({
  testDir: ".",
  testIgnore: ["**/electrobun-shell.spec.ts"],
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
});
