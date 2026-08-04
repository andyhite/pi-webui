import { defineConfig } from "vitest/config";

/**
 * The repository-tooling tests — `scripts/**` — which turbo does not reach
 * because `scripts/` is not a workspace package. `pnpm test:scripts` runs
 * this, and `pnpm verify` and CI both call it beside turbo's per-package pass:
 * a separate script rather than chained onto the turbo one, so
 * `pnpm test <file>`'s arguments still reach turbo.
 */
export default defineConfig({
  test: {
    include: ["scripts/**/*.test.ts"],
  },
});
