//! PlotRoom desktop shell — thin Rust main (#316). Scope fence, binding on
//! this crate: window lifecycle, spawn-or-attach, sidecar lifecycle,
//! single-instance enforcement. **No product logic in Rust** — the renderer
//! (`apps/web`, loaded unmodified) is the entire product surface, and it
//! uses no Tauri JS API: browser-mode behavior stays identical whether it
//! is opened in a normal browser tab or inside this window.
//!
//! The updater plugin (registered below) points `tauri.conf.json` at a
//! plain-`http` placeholder endpoint and sets
//! `dangerousInsecureTransportProtocol: true` to allow it -- hosting a real
//! signed feed over `https` is explicitly deferred (#309's ADR §6: "ships
//! unsigned", a follow-up issue picks up real certificates and hosting).
//! Swapping to a real host means swapping the endpoint back to `https` and
//! removing that flag, not touching this file.

mod sidecar;
mod spawn_or_attach;

use std::env;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use sidecar::{ServerSpawner, SidecarLayout};
use spawn_or_attach::{spawn_or_attach, HttpHealthProbe, SpawnOrAttachConfig, SpawnOrAttachResult};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const DEFAULT_PLOTROOM_PORT: u16 = 4600;

fn resolve_host() -> String {
    env::var("PLOTROOM_HOST").unwrap_or_else(|_| "127.0.0.1".to_string())
}

fn resolve_port() -> u16 {
    env::var("PLOTROOM_PORT")
        .ok()
        .and_then(|raw| raw.parse().ok())
        .unwrap_or(DEFAULT_PLOTROOM_PORT)
}

fn resolve_state_dir() -> PathBuf {
    if let Ok(dir) = env::var("PLOTROOM_STATE_DIR") {
        return PathBuf::from(dir);
    }
    dirs_state_dir()
}

#[cfg(not(test))]
fn dirs_state_dir() -> PathBuf {
    let home = env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".plotroom")
}

#[cfg(test)]
fn dirs_state_dir() -> PathBuf {
    PathBuf::from("/tmp/plotroom-test-state")
}

/// Dev vs packaged: a packaged app has a real `resource_dir()`/binaries
/// directory Tauri populated from `bundle.resources`/`bundle.externalBin`;
/// a `cargo tauri dev` run has neither, and falls back to the same
/// sibling-`apps/*/out` layout dev already assumed under Electron.
///
/// Two path corrections here, both found running the real packaged app on
/// this platform for the first time (#316's own "macOS unverified" gap —
/// both silently wrong on macOS, both silently right on Linux, which is
/// exactly why the gap stayed hidden):
///
/// - `binaries_dir` is the *executable's own* directory
///   (`current_exe().parent()`), never `resource_dir()`: Tauri places
///   `externalBin` sidecars beside the app's own binary, not inside its
///   resources directory — the same directory on Linux (deb/AppImage
///   install both together) but genuinely different on macOS
///   (`Contents/MacOS/` vs `Contents/Resources/`).
/// - the resource *root* actually used below is `resource_dir` **plus**
///   `resources/`: `tauri.conf.json`'s `bundle.resources` glob
///   (`"resources/**/*"`, relative to `src-tauri/`) preserves that
///   `resources/` path segment when Tauri copies matches into the bundle,
///   so `stage-sidecars.mjs`'s own `src-tauri/resources/plotroom-session-host`
///   lands at `Contents/Resources/resources/plotroom-session-host`, not
///   `Contents/Resources/plotroom-session-host`.
fn resolve_sidecar_layout(app: &tauri::AppHandle) -> SidecarLayout {
    if let Ok(app_resource_dir) = app.path().resource_dir() {
        let resource_dir = app_resource_dir.join("resources");
        let binaries_dir = env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.to_path_buf()))
            .unwrap_or_else(|| resource_dir.clone());
        let session_host_candidate = resource_dir.join(if cfg!(windows) {
            "plotroom-session-host.exe"
        } else {
            "plotroom-session-host"
        });
        if session_host_candidate.exists() {
            return SidecarLayout::packaged(&resource_dir, &binaries_dir);
        }
    }
    let repo_root = env::current_dir()
        .ok()
        .and_then(|cwd| {
            // `cargo tauri dev` runs from `apps/desktop/src-tauri`; the repo
            // root is three directories up.
            cwd.ancestors().nth(3).map(|p| p.to_path_buf())
        })
        .unwrap_or_else(|| PathBuf::from("."));
    SidecarLayout::dev(&repo_root)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `RUST_LOG` (default `info`), because `log::info!`/`log::error!` below
    // are silent without a registered backend -- discovered running #316's
    // own dry run under Xvfb, where a missing "spawned server sidecar" line
    // read as a hang until this was added.
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch focuses the existing window instead of
            // opening a second one, and never spawns a second server —
            // exactly the "one gesture creates one thing" principle (spec
            // principle 9) applied to the desktop shell itself.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let host = resolve_host();
            let port = resolve_port();
            let state_dir = resolve_state_dir();
            let config = SpawnOrAttachConfig {
                host: host.clone(),
                port,
                ready_timeout: Duration::from_secs(10),
                poll_interval: Duration::from_millis(200),
            };

            let layout = resolve_sidecar_layout(app.handle());
            let mut spawner = ServerSpawner::new(layout, host.clone(), port, state_dir);
            let mut attach_probe = HttpHealthProbe::new(&config);

            let result = spawn_or_attach(&config, &mut attach_probe, &mut spawner);
            let url = config.url();
            match result {
                Ok(SpawnOrAttachResult::Attached) => {
                    log::info!("attached to an already-running server at {url}");
                }
                Ok(SpawnOrAttachResult::Spawned { pid }) => {
                    log::info!("spawned server sidecar (pid {pid}) at {url}");
                    app.manage(Mutex::new(SpawnedSidecar { spawner }));
                }
                Err(err) => {
                    // No product logic in Rust: this is not a retry policy
                    // or a fallback UI, just the one honest report the shell
                    // itself can make before there is anything to show.
                    log::error!("failed to start the local server: {err}");
                    return Err(Box::new(err));
                }
            }

            let parsed_url = url.parse().expect("spawn-or-attach always produces a valid http(s) URL");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed_url))
                .title("PlotRoom")
                .inner_size(1280.0, 800.0)
                .build()?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Only the last window closing tears the sidecar down — this
            // shell opens exactly one window, so "last" is "the only one",
            // but stated as a condition rather than assumed, in case that
            // ever changes.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.app_handle().webview_windows().len() <= 1 {
                    if let Some(state) = window
                        .app_handle()
                        .try_state::<Mutex<SpawnedSidecar>>()
                    {
                        if let Ok(mut guard) = state.lock() {
                            guard.spawner.shutdown();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the PlotRoom desktop shell");
}

/// Tracked in Tauri's managed state only when this launch actually spawned
/// the sidecar (never for an attach) — so shutdown never kills a server
/// this process merely attached to.
struct SpawnedSidecar {
    spawner: ServerSpawner,
}
