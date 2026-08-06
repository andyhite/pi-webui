import globals from "globals";

import shared from "@plotroom/eslint-config";

export default [
  ...shared,
  {
    // Linting reaches this package's build scripts as well as its sources —
    // `scripts/*.mjs` stages and packages the desktop app, and a build script
    // nothing lints is how a typo there becomes a broken installer. They are
    // plain Node modules, so they get Node's globals; TypeScript files need no
    // such block because typescript-eslint turns `no-undef` off for them (the
    // compiler says it better).
    files: ["**/*.mjs", "**/*.cjs"],
    languageOptions: { globals: globals.node },
  },
  {
    // Tooling run by a human at a terminal — this package's build scripts
    // (`scripts/`, which stage and package the app): its output *is* its
    // interface, and a release script that could not print the version and
    // notes it derived would have no dry-run mode to review. The `no-console`
    // warning is there to keep logging out of the product, where the server
    // has a real logger; nothing here runs in the product.
    files: ["scripts/**/*.{ts,mjs,cjs,js}"],
    rules: { "no-console": "off" },
  },
  {
    // The desktop backend picker's own page (Epic 8.4): a static file loaded
    // via `BrowserWindow.loadFile`, never bundled, running as a plain browser
    // script against the narrow bridge `backend-picker-preload.ts` exposes as
    // `window.plotroomBackends`. Browser globals only — it never reaches for
    // Node, same reasoning as the plugin-renderer override in
    // `packages/plugins/*/eslint.config.js`.
    files: ["src/backend-picker.js"],
    languageOptions: {
      globals: { window: "readonly", document: "readonly" },
    },
  },
];
