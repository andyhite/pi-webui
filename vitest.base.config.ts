import { defineConfig } from "vitest/config";

/**
 * The test-runner configuration every package shares, so the include pattern is
 * stated once instead of being copied into a dozen files. Vitest resolves a
 * package's own `vitest.config.ts`, which re-exports this;
 * `scripts/workspace-tooling.test.ts` asserts that every package's config
 * really does resolve to it.
 *
 * `src/**\/*.test.ts` and nothing else. `.spec.ts` is Playwright's suffix in
 * this repository (`apps/web/e2e`) — a separate, explicitly-run suite vitest
 * must never collect — and a package's `dist/` carries no tests to pick up,
 * because the build excludes them.
 *
 * `apps/session-host` is the one package with no config: it runs on Bun and its
 * tests import `bun:test` (decision 0005).
 */
export const packageTests = defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
