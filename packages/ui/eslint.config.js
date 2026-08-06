import { workspaceConventions } from "@plotroom/eslint-config/workspace-conventions";

// `lint` is `oxlint --type-aware` now (#307); this config carries only the
// workspace-convention checks over package.json/tsconfig.json that oxlint
// cannot run (it does not lint JSON). No architectural override applies to
// this package.
export default workspaceConventions();
