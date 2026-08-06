import { workspaceConventions } from "@plotroom/eslint-config/workspace-conventions";

// `lint` is `oxlint --type-aware` now (#307); this config carries only the
// workspace-convention checks over package.json/tsconfig.json that oxlint
// cannot run (it does not lint JSON). No architectural override applies to
// this package.
export default workspaceConventions({
  testOverride:
    "bun test src --exclude src/plugins/conditions.test.ts --exclude src/plugins/invoker.test.ts && vitest run src/plugins/conditions.test.ts src/plugins/invoker.test.ts",
});
