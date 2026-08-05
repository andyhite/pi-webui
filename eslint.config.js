import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

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
  {
    // Each package lints itself with `eslint .`, so linting now reaches its
    // build scripts as well as its sources — `apps/desktop/scripts/*.mjs`
    // stages and packages the desktop app, and a build script nothing lints is
    // how a typo there becomes a broken installer. They are plain Node modules,
    // so they get Node's globals; TypeScript files need no such block because
    // typescript-eslint turns `no-undef` off for them (the compiler says it
    // better).
    files: ["**/*.mjs", "**/*.cjs"],
    languageOptions: { globals: globals.node },
  },
  {
    // Tooling run by a human at a terminal — the repository's own scripts
    // (`scripts/`, #94) and a package's build scripts (`apps/desktop/scripts`,
    // which stages and packages the app): its output *is* its interface, and a
    // release script that could not print the version and notes it derived
    // would have no dry-run mode to review. The `no-console` warning is there
    // to keep logging out of the product, where the server has a real logger;
    // nothing here runs in the product.
    files: [
      "scripts/**/*.ts",
      "{apps,packages}/**/scripts/**/*.{ts,mjs,cjs,js}",
    ],
    rules: { "no-console": "off" },
  },
  {
    // `@plotroom/toolkit` is the design system, and its dependency direction is
    // one way: `apps/web` -> `@plotroom/ui` -> `@plotroom/toolkit` (#101). It
    // imports nothing from this workspace at all — not core, not a plugin, and
    // not the plugin SDK, whose entry reaches the worker host and would put Node
    // in a package the renderer bundles (the same failure the override below
    // exists for).
    //
    // The toolkit still has to agree with the SDK's frozen
    // `Theme { tokens: Record<string, string> }`, so the compile-time proof that
    // it does lives in `packages/ui/src/theme/sdk-contract.ts` — the one package
    // that can see both types, exactly like `apps/server/src/plugins/raise.ts`.
    // Drift on either side is a build error, and the toolkit keeps zero
    // workspace dependencies.
    files: ["packages/toolkit/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@plotroom/*"],
              message:
                "@plotroom/toolkit depends on nothing in this workspace (#101). A type it needs from the plugin SDK is asserted in packages/ui/src/theme/sdk-contract.ts instead.",
            },
          ],
        },
      ],
      // `no-restricted-imports` visits import and export declarations only, so a
      // dynamic `import()` walks straight past it. The rule is what this change
      // presents as the enforcement, so it has to refuse both forms.
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression[source.value=/^@plotroom\\//]",
          message:
            "@plotroom/toolkit depends on nothing in this workspace (#101), dynamically either.",
        },
      ],
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
  {
    // The desktop backend picker's own page (Epic 8.4): a static file loaded
    // via `BrowserWindow.loadFile`, never bundled, running as a plain browser
    // script against the narrow bridge `backend-picker-preload.ts` exposes as
    // `window.plotroomBackends`. Browser globals only — it never reaches for
    // Node, same reasoning as the plugin-renderer override above.
    files: ["apps/desktop/src/backend-picker.js"],
    languageOptions: {
      globals: { window: "readonly", document: "readonly" },
    },
  },
);
