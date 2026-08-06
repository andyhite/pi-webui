/**
 * Trees a package's own `eslint .` should never walk, shared between the
 * full base config (`index.js`) and the micro-ESLint passes (`architectural`,
 * `workspace-conventions`) so a generated file never runs through a
 * hand-written rule twice — once as source, once as its own compiled output.
 */
export const IGNORES = [
  "**/dist/**",
  "**/node_modules/**",
  "**/.turbo/**",
  "**/.vite/**",
  "**/coverage/**",
  // Playwright's own output, which `pnpm --filter @plotroom/web e2e`
  // writes into the package `eslint .` runs in.
  "**/playwright-report/**",
  "**/test-results/**",
  // Generated trees a package's own `eslint .` would otherwise walk:
  // `apps/server`/`apps/session-host`'s `compile` writes `out/`, and
  // `apps/desktop/scripts/stage-sidecars.mjs` (#316) copies those artifacts
  // into `src-tauri/binaries/`/`src-tauri/resources/` (gitignored) before
  // `cargo tauri build`. Gitignored is not eslint-ignored — these lists have
  // to be kept agreeing by hand.
  "**/build/**",
  "**/out/**",
  "apps/desktop/src-tauri/target/**",
  "apps/desktop/src-tauri/gen/**",
];
