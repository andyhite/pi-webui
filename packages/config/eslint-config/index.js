import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

// The shared base every workspace package's `eslint.config.js` re-exports
// (`packages/config/typescript-config`'s eslint sibling). Package-specific
// overrides (architectural rules, per-file globals, tooling exceptions) live
// in the consuming package's own config, not here — this stays the common
// denominator so a change to it is a change every consumer actually shares.
//
// This is a skeleton: the custom ESLint-plugin rules (workspace-convention
// and architectural checks) land here in a later change (see the linter
// modernization task), not in this one.
export default tseslint.config(
  {
    ignores: [
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
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
);
