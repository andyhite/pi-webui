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
  // `apps/desktop/scripts/stage-resources.mjs` stages a whole `pnpm deploy`
  // tree into `build/`, and electron-builder writes `dist-installers/`.
  // Gitignored is not eslint-ignored — these two lists have to be kept
  // agreeing by hand.
  "**/build/**",
  "**/out/**",
  "**/dist-installers/**",
];
