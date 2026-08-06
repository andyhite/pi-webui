import shared from "@plotroom/eslint-config";

export default [
  ...shared,
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
    // it here; the current graph (root `eslint.config.js`'s previous home for
    // this rule, before packages/config/eslint-config#306) is:
    //
    //   filesystem  renderer-manifest -> card-renderer, content-renderer,
    //                                    palette, card-meta
    //   git         renderer-manifest -> renderers
    //   github      renderer-manifest -> renderers, palette
    //   jira        renderer-manifest -> renderers (-> write-action-ids),
    //                                    palette (-> scope)
    files: [
      "src/renderer-manifest.ts",
      "src/renderers.ts",
      "src/card-renderer.ts",
      "src/content-renderer.ts",
      "src/card-meta.ts",
      "src/palette.ts",
      "src/scope.ts",
      "src/write-action-ids.ts",
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
];
