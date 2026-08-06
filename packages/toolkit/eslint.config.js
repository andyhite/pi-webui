import { architectural } from "@plotroom/eslint-config/architectural";
import { workspaceConventions } from "@plotroom/eslint-config/workspace-conventions";

// `lint` is `oxlint --type-aware` now (#307). The toolkit-encapsulation
// architectural rule (#101 — this package depends on nothing else in the
// workspace) still runs under ESLint here, ported as-is from the
// `no-restricted-imports`/`no-restricted-syntax` pair this file used to
// carry directly.
export default [...workspaceConventions(), ...architectural({ toolkit: true })];
