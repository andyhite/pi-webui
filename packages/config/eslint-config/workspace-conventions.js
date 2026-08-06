import json from "@eslint/json";

import { IGNORES } from "./ignores.js";
import plugin from "./plugin.js";

/**
 * The workspace-convention half of the micro-ESLint pass (#307): the build
 * tooling contract every package answers to (#215), now enforced on
 * `package.json` / `tsconfig*.json` directly instead of asserted from
 * `scripts/workspace-tooling.test.ts`. Uses ESLint's official `@eslint/json`
 * language plugin so these are ordinary ESLint rules, not a bespoke script.
 *
 * @param {{ testOverride?: string }} [packageJsonOptions]
 */
export function workspaceConventions(packageJsonOptions = {}) {
  return [
    { ignores: IGNORES },
    {
      files: ["package.json"],
      plugins: { json, plotroom: plugin },
      language: "json/json",
      rules: {
        "plotroom/package-json-conventions": ["error", packageJsonOptions],
      },
    },
    {
      files: ["tsconfig.json"],
      plugins: { json, plotroom: plugin },
      language: "json/jsonc",
      rules: {
        "plotroom/tsconfig-shape": "error",
      },
    },
  ];
}
