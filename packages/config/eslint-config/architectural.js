import tseslint from "typescript-eslint";

import { IGNORES } from "./ignores.js";
import plugin from "./plugin.js";

/**
 * The renderer-reachable module graph banned from Node imports/globals
 * (#307's port of the per-plugin `no-restricted-imports` override).
 * **This list must be every module a `renderer-manifest.ts` can reach,
 * transitively** — a guard over an entry's imports but not its imports'
 * imports is a guard with a hole in it. Current graph:
 *
 *   filesystem  renderer-manifest -> card-renderer, content-renderer,
 *                                    palette, card-meta
 *   git         renderer-manifest -> renderers
 *   github      renderer-manifest -> renderers, palette
 *   jira        renderer-manifest -> renderers (-> write-action-ids),
 *                                    palette (-> scope)
 */
export const RENDERER_REACHABLE_FILES = [
  "src/renderer-manifest.ts",
  "src/renderers.ts",
  "src/card-renderer.ts",
  "src/content-renderer.ts",
  "src/card-meta.ts",
  "src/palette.ts",
  "src/scope.ts",
  "src/write-action-ids.ts",
];

/**
 * The micro-ESLint pass for a package's JS/TS architectural rules — the
 * `toolkit-encapsulation` and `renderer-no-node-import` checks from
 * `packages/config/eslint-config/rules`. Deliberately does not include
 * `js.configs.recommended` / `tseslint.configs.recommended`: general JS/TS
 * linting is oxlint's job now (`lint` = `oxlint --type-aware`); ESLint's
 * remaining job is the two rules oxlint's JS-plugin host cannot yet run
 * (#307).
 *
 * @param {{ toolkit?: boolean; renderer?: boolean }} [options]
 */
export function architectural({ toolkit = false, renderer = false } = {}) {
  /** @type {Array<import("eslint").Linter.Config>} */
  const configs = [{ ignores: IGNORES }];
  if (toolkit) {
    configs.push({
      files: ["**/*.{ts,tsx}"],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      plugins: { plotroom: plugin },
      rules: { "plotroom/toolkit-encapsulation": "error" },
    });
  }
  if (renderer) {
    configs.push({
      files: RENDERER_REACHABLE_FILES,
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      plugins: { plotroom: plugin },
      rules: { "plotroom/renderer-no-node-import": "error" },
    });
  }
  return configs;
}
