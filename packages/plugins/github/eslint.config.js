import { architectural } from "@plotroom/eslint-config/architectural";
import { workspaceConventions } from "@plotroom/eslint-config/workspace-conventions";

// `lint` is `oxlint --type-aware` now (#307). The renderer-no-node-import
// architectural rule still runs under ESLint here, ported as-is from the
// `no-restricted-imports`/`no-restricted-globals` pair this file used to
// carry directly (see `@plotroom/eslint-config/architectural` for the
// renderer-reachable file list and why it must be transitive).
//
// `test` is Bun's own runner, not vitest (#315): `host.integration.test.ts`
// now loads `../src/index.ts` and `../src/testing/stub-entry.ts` directly
// (no build) — see `packages/plugins/git/eslint.config.js` for why that
// needs a real Bun worker rather than vitest's pool.
export default [
  ...workspaceConventions({ testOverride: "bun test src" }),
  ...architectural({ renderer: true }),
];
