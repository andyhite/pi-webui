import { workspaceConventions } from "@plotroom/eslint-config/workspace-conventions";

// `lint` is `oxlint --type-aware` (#307) even though this package carries no
// TS source anymore (#316: the desktop shell is a thin Rust/Tauri main now) —
// kept literal so the shared workspace-convention rule needs no per-package
// exception, and it is a true no-op with nothing to match. Rust's own lint is
// `lint:rust` (`cargo clippy`), a separate script name the convention rule
// does not police. `test` overrides to the literal `cargo test` invocation,
// prefixed with `ensure-test-stub.mjs` (see that script's own comment): a
// plain `cargo test`/`cargo clippy` still runs `tauri-build`'s build script,
// which fails the whole compile if `tauri.conf.json`'s `bundle.externalBin`
// binary is not staged, and this job never runs `stage-sidecars.mjs` first.
export default workspaceConventions({
  testOverride:
    "node scripts/ensure-test-stub.mjs && cd src-tauri && cargo test",
});
