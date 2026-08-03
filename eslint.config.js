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
    // React mounted. These files are the renderer entry and the leaf modules it
    // imports; the host entry (`index.ts`) and everything under it is where the
    // machine is allowed to be touched.
    files: [
      "packages/plugins/*/src/renderer-manifest.ts",
      "packages/plugins/*/src/renderers.ts",
      "packages/plugins/*/src/card-renderer.ts",
      "packages/plugins/*/src/content-renderer.ts",
      "packages/plugins/*/src/card-meta.ts",
      "packages/plugins/*/src/palette.ts",
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
