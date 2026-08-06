import { workspaceConventions } from "@plotroom/eslint-config/workspace-conventions";

// `lint` is `oxlint --type-aware` (#307) even though this package carries no
// TS source anymore (#316: the desktop shell is a thin Rust/Tauri main now) —
// kept literal so the shared workspace-convention rule needs no per-package
// exception, and it is a true no-op with nothing to match. Rust's own lint is
// `lint:rust` (`cargo clippy`), a separate script name the convention rule
// does not police. `test` overrides to `cargo test` for the same reason.
export default workspaceConventions({
  testOverride: "cd src-tauri && cargo test",
});
