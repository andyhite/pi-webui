import { workspaceConventions } from "@plotroom/eslint-config/workspace-conventions";

// `lint` is `oxlint --type-aware` now (#307); this config otherwise carries
// only the workspace-convention checks over package.json/tsconfig.json that
// oxlint cannot run (it does not lint JSON). `test` is Bun's own runner
// (#313: `client.ts` imports `bun:sqlite`, which only resolves inside the
// actual Bun runtime -- Vitest's worker pool spawns processes that cannot
// see it, confirmed empirically, not a preference) -- `bun:test`, no vitest
// config, the same deviation `apps/session-host` already carries for
// decision 0005. `--timeout 20000` widens Bun's 5s default: several of this
// package's tests write real files to a fresh temp state directory per test
// (not `:memory:`) and CI's windows-latest runner measurably needs more than
// 5s for some of the heavier migration fixtures (up to ~14s observed) -- a
// platform-speed fact, not a hung test.
export default workspaceConventions({
  testOverride: "bun test src --timeout 20000",
});
