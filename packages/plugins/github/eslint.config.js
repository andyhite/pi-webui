import { architectural } from "@plotroom/eslint-config/architectural";
import { workspaceConventions } from "@plotroom/eslint-config/workspace-conventions";

// `lint` is `oxlint --type-aware` now (#307). The renderer-no-node-import
// architectural rule still runs under ESLint here, ported as-is from the
// `no-restricted-imports`/`no-restricted-globals` pair this file used to
// carry directly (see `@plotroom/eslint-config/architectural` for the
// renderer-reachable file list and why it must be transitive). `test` builds
// first: `host.integration.test.ts` loads `../dist/index.js` and
// `../dist/testing/stub-entry.js`.
export default [
  ...workspaceConventions({ buildsOwnDist: true }),
  ...architectural({ renderer: true }),
];
