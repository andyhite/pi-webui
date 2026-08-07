// `tauri_build::build()` embeds the Windows Common-Controls-v6 manifest (the
// dialog/theming APIs the plugins here rely on need it) via
// `tauri-winres`'s `res.compile()`, which links it with `-bins` --
// `[[bin]]` targets only, never `cargo test`'s binaries. `updater_dry_run.rs`
// builds a `tauri::test::mock_builder()` app, which still touches those
// comctl32 entry points, so the test binary crashes at startup with
// `STATUS_ENTRYPOINT_NOT_FOUND` (confirmed upstream:
// tauri-apps/tauri#13419 -- open, unresolved as of this writing). The
// maintainer-confirmed workaround: opt out of `tauri-winres`'s manifest
// embedding and instead pass the same manifest to the linker via
// `cargo:rustc-link-arg` (no `-bins` suffix), which Cargo applies to every
// artifact this crate produces, tests included.
fn main() {
    #[cfg(windows)]
    let attributes = {
        embed_windows_manifest_in_every_artifact();
        tauri_build::Attributes::new().windows_attributes(
            tauri_build::WindowsAttributes::new_without_app_manifest(),
        )
    };
    #[cfg(not(windows))]
    let attributes = tauri_build::Attributes::new();

    tauri_build::try_build(attributes).expect("tauri-build failed");
}

#[cfg(windows)]
fn embed_windows_manifest_in_every_artifact() {
    let manifest = std::env::current_dir()
        .expect("failed to resolve the crate's working directory")
        .join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg=/MANIFESTINPUT:{}",
        manifest.display()
    );
    // A silently-dropped manifest embed would resurrect this exact bug;
    // fail the link instead of shipping a binary that looks fine and isn't.
    println!("cargo:rustc-link-arg=/WX");
}
