import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

import { IGNORES } from "./ignores.js";

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
    ignores: IGNORES,
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
