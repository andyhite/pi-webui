import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/coverage/**",
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
  {
    // A plugin's renderer half runs in the browser (`@plotroom/ui`'s
    // `ContributionRegistry` calls these contributions in the page), so nothing
    // in this graph may reach for Node. It is not a style rule: importing a
    // plugin's host entry into the renderer once put `os.tmpdir()` in the
    // bundle, where it ran at module scope and killed the whole canvas before
    // React mounted. The host entry (`index.ts`) and everything only it reaches
    // is where the machine is allowed to be touched.
    //
    // **This list must be every module a `renderer-manifest.ts` can reach,
    // transitively — not just the ones named "renderer".** A guard over an
    // entry's imports but not its imports' imports is a guard with a hole in it:
    // Jira's card renderer named a write action by importing its id from
    // `writes.ts`, which pulled `transport.js` (and its `Buffer`) into the
    // renderer graph one module past where this override reached. That id now
    // lives in `write-action-ids.ts`, a leaf, and every file below is a leaf or
    // imports only files below. Adding a renderer-reachable module means adding
    // it here; the current graph is:
    //
    //   filesystem  renderer-manifest -> card-renderer, content-renderer,
    //                                    palette, card-meta
    //   git         renderer-manifest -> renderers
    //   github      renderer-manifest -> renderers, palette
    //   jira        renderer-manifest -> renderers (-> write-action-ids),
    //                                    palette (-> scope)
    files: [
      "packages/plugins/*/src/renderer-manifest.ts",
      "packages/plugins/*/src/renderers.ts",
      "packages/plugins/*/src/card-renderer.ts",
      "packages/plugins/*/src/content-renderer.ts",
      "packages/plugins/*/src/card-meta.ts",
      "packages/plugins/*/src/palette.ts",
      "packages/plugins/*/src/scope.ts",
      "packages/plugins/*/src/write-action-ids.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*"],
              message:
                "a plugin's renderer contributions run in the browser: keep Node imports in the host entry (index.ts) and the modules it owns",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        {
          name: "Buffer",
          message:
            "no Buffer in a renderer contribution (it does not exist in a browser tab) \u2014 use TextEncoder/TextDecoder",
        },
        {
          name: "process",
          message:
            "no process in a renderer contribution (it does not exist in a browser tab)",
        },
      ],
    },
  },
);
