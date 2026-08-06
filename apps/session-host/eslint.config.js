import { workspaceConventions } from "@plotroom/eslint-config/workspace-conventions";

// `lint` is `oxlint --type-aware` now (#307). No architectural override
// applies to this package. `test` is Bun's own runner (decision 0005) —
// `bun:test`, no vitest config — the one deviation the old meta-test's
// `NOT_VITEST` table named.
export default workspaceConventions({ testOverride: "bun test src" });
