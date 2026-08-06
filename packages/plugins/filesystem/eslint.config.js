import { architectural } from "@plotroom/eslint-config/architectural";
import { workspaceConventions } from "@plotroom/eslint-config/workspace-conventions";

// `lint` is `oxlint --type-aware` now (#307). The renderer-no-node-import
// architectural rule still runs under ESLint here, ported as-is from the
// `no-restricted-imports`/`no-restricted-globals` pair this file used to
// carry directly (see `@plotroom/eslint-config/architectural` for the
// renderer-reachable file list and why it must be transitive).
//
// `test` is Bun's own runner, not vitest (#315): `host.test.ts` now loads
// `../src/index.ts` directly (no build), the same specifier the product
// resolves at runtime — and that raw-TS worker load only resolves under a
// real Bun worker thread, confirmed empirically; vitest's own worker pool
// does not give the spawned `new Worker()` Bun's module loader, even when
// vitest itself runs under `bun run` (same fix as the git/github/jira
// plugins' own `host.integration.test.ts`).
export default [
  ...workspaceConventions({ testOverride: "bun test src" }),
  ...architectural({ renderer: true }),
];
