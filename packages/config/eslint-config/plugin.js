import packageJsonConventions from "./rules/package-json-conventions.js";
import rendererNoNodeImport from "./rules/renderer-no-node-import.js";
import toolkitEncapsulation from "./rules/toolkit-encapsulation.js";
import tsconfigShape from "./rules/tsconfig-shape.js";

/**
 * The workspace's own architectural + convention rules, written once here
 * (#307) instead of copy-pasted per package as `no-restricted-imports`
 * overrides, and instead of asserted from `scripts/workspace-tooling.test.ts`.
 * ESLint-plugin format runs under ESLint today and under oxlint's
 * ESLint-v9-compatible JS-plugin host (alpha) later without a rewrite.
 */
const plugin = {
  meta: {
    name: "@plotroom/eslint-config",
    version: "0.0.0",
  },
  rules: {
    "toolkit-encapsulation": toolkitEncapsulation,
    "renderer-no-node-import": rendererNoNodeImport,
    "package-json-conventions": packageJsonConventions,
    "tsconfig-shape": tsconfigShape,
  },
};

export default plugin;
