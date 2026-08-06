import { defineConfig } from "@playwright/test";

/**
 * The #84 shell spike, on its own config because it is opt-in by
 * construction rather than by convention: on a cold scratch directory it
 * downloads ~210MB of Electrobun CLI, core and CEF tarballs and expands
 * them to ~1.6GB, needs `bun` and an X display, and drives a desktop shell the stack has not adopted (#78
 * deferred it past M1). The default gate `testIgnore`s the same file, so
 * neither config can pick up the other's tests.
 *
 * Nothing here launches a browser: the spec attaches to the CEF window the
 * app opens (`chromium.connectOverCDP`), so Playwright's own browser
 * fixtures are unused and `use` deliberately configures none of them.
 *
 * Requires `bun run build` first, for the same reason the default gate does —
 * it spawns `apps/server/dist/index.js` serving `apps/web/dist`.
 *
 *   bun run build && bun run --filter=@plotroom/web e2e:electrobun
 */
export default defineConfig({
  testDir: ".",
  testMatch: ["**/electrobun-shell.spec.ts"],
  // A cold run builds a CEF bundle before the window opens; the spec raises
  // its own timeout further still.
  timeout: 15 * 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
});
