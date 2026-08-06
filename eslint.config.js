import shared from "@plotroom/eslint-config";

// Root-only scope now: the repository's own tooling (`scripts/`, #94) and the
// root config files (`*.config.js`, `*.config.ts`) that `pnpm lint:scripts`
// covers. Every workspace package lints itself against
// `@plotroom/eslint-config` from its own `eslint.config.js` — see
// `packages/config/eslint-config` and issue #306.
export default [
  ...shared,
  {
    // Tooling run by a human at a terminal: its output *is* its interface, and
    // a release script that could not print the version and notes it derived
    // would have no dry-run mode to review. The `no-console` warning is there
    // to keep logging out of the product, which nothing here is.
    files: ["scripts/**/*.ts"],
    rules: { "no-console": "off" },
  },
];
