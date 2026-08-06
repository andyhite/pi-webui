import shared from "@plotroom/eslint-config";

export default [
  ...shared,
  {
    // `@plotroom/toolkit` is the design system, and its dependency direction is
    // one way: `apps/web` -> `@plotroom/ui` -> `@plotroom/toolkit` (#101). It
    // imports nothing from this workspace at all — not core, not a plugin, and
    // not the plugin SDK, whose entry reaches the worker host and would put Node
    // in a package the renderer bundles (the same failure the plugin-renderer
    // override in `packages/plugins/*/eslint.config.js` exists for).
    //
    // The toolkit still has to agree with the SDK's frozen
    // `Theme { tokens: Record<string, string> }`, so the compile-time proof that
    // it does lives in `packages/ui/src/theme/sdk-contract.ts` — the one package
    // that can see both types, exactly like `apps/server/src/plugins/raise.ts`.
    // Drift on either side is a build error, and the toolkit keeps zero
    // workspace dependencies.
    files: ["**/*.{ts,tsx}"],
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
];
