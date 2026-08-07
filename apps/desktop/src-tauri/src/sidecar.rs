//! Sidecar lifecycle: resolving the compiled server binary and spawning it
//! with the process-tree protections #308's S2 spike named as real,
//! solvable requirements rather than kill conditions:
//!
//! 1. The session-host artifact is a *directory* (binary + ~155MB native
//!    addon files), so it ships via `bundle.resources` (co-located at
//!    runtime), never `bundle.externalBin` (which assumes one file). The
//!    server itself has no native addon of its own — `bun:sqlite` is inside
//!    the Bun runtime the compiled binary embeds — so it is the one
//!    `externalBin` entry.
//! 2. This module does not need fd-3/`FRAME_FD` plumbing itself: the server
//!    (not this Rust process) spawns session-host and owns that channel
//!    already (`apps/server/src/runtime/omp.ts`). This process only ever
//!    talks to the server sidecar over its HTTP health route and the
//!    server's own `PLOTROOM_SESSION_HOST` env var, which is where the
//!    session-host binary's resolved path is threaded through.
//! 3. Parent-death child-orphan: confirmed on Linux, a plain spawned child
//!    is *not* killed when its parent dies — it is re-parented to init and
//!    keeps running. Guarded here with `PR_SET_PDEATHSIG(SIGKILL)` in a
//!    `pre_exec` hook (Unix) plus an explicit `killpg` on our own teardown,
//!    so both "we died unexpectedly" and "we chose to stop" tear the sidecar
//!    down.

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

use crate::spawn_or_attach::Spawner;

pub struct SidecarLayout {
    /// The compiled server binary this process spawns as `externalBin`.
    pub server_binary: PathBuf,
    /// The compiled session-host binary, threaded to the server via
    /// `PLOTROOM_SESSION_HOST` — this process never spawns it directly.
    pub session_host_binary: PathBuf,
    /// `apps/web`'s built renderer, threaded to the spawned server via
    /// `PLOTROOM_STATIC_DIR`. The server's own default
    /// (`config.ts`'s `defaultStaticDir`, `../../web/dist` relative to its
    /// own module URL) resolves against the monorepo's on-disk layout, which
    /// a `bun build --compile` standalone binary's virtual `$bunfs/` module
    /// URL does not have — the compiled server has no on-disk sibling
    /// `apps/web`, so this path always needs stating explicitly for a
    /// packaged (or dev-mode-but-compiled) sidecar to serve the canvas at
    /// all rather than the 503 "no built renderer" fallback.
    pub web_dist: PathBuf,
}

impl SidecarLayout {
    /// Dev-mode layout: the sibling `out/` directories `bun run compile`
    /// produces in each app, matching the same sibling-repo-layout
    /// assumption the deleted Electron main.ts made for its own dev-mode
    /// `SERVER_ENTRY` (`AGENTS.md`).
    pub fn dev(repo_root: &Path) -> Self {
        let server_binary_name = if cfg!(windows) {
            "plotroom-server.exe"
        } else {
            "plotroom-server"
        };
        let session_host_binary_name = if cfg!(windows) {
            "plotroom-session-host.exe"
        } else {
            "plotroom-session-host"
        };
        Self {
            server_binary: repo_root
                .join("apps/server/out")
                .join(server_binary_name),
            session_host_binary: repo_root
                .join("apps/session-host/out")
                .join(session_host_binary_name),
            web_dist: repo_root.join("apps/web/dist"),
        }
    }

    /// Packaged layout: Tauri resolves `externalBin` sidecars into the
    /// bundle's own binary directory (suffixed with the target triple at
    /// build time, stripped back off by the resolver at runtime) and
    /// `resources` into the app's resource directory. `web-dist/` is this
    /// crate's own resource subdirectory (`stage-sidecars.mjs`), not a
    /// Tauri-managed one — `frontendDist` in `tauri.conf.json` is unused at
    /// runtime by design (this shell loads the *server's* URL, not Tauri's
    /// own asset protocol, so the renderer stays byte-identical to browser
    /// mode; see `lib.rs`), so the built renderer has to reach the spawned
    /// server sidecar by some other path than Tauri's normal one.
    pub fn packaged(resource_dir: &Path, binaries_dir: &Path) -> Self {
        let server_binary_name = if cfg!(windows) {
            "plotroom-server.exe"
        } else {
            "plotroom-server"
        };
        let session_host_binary_name = if cfg!(windows) {
            "plotroom-session-host.exe"
        } else {
            "plotroom-session-host"
        };
        Self {
            server_binary: binaries_dir.join(server_binary_name),
            session_host_binary: resource_dir.join(session_host_binary_name),
            web_dist: resource_dir.join("web-dist"),
        }
    }
}

pub struct ServerSpawner {
    pub layout: SidecarLayout,
    pub host: String,
    pub port: u16,
    pub state_dir: PathBuf,
    child: Option<Child>,
    pid: Option<u32>,
}

impl ServerSpawner {
    pub fn new(layout: SidecarLayout, host: String, port: u16, state_dir: PathBuf) -> Self {
        Self {
            layout,
            host,
            port,
            state_dir,
            child: None,
            pid: None,
        }
    }

    /// Tears the sidecar down unconditionally — the shell's own shutdown
    /// path (window closed, app quitting), as opposed to `Spawner::kill`'s
    /// "our own spawn attempt never became healthy" path. Both end up at the
    /// same `killpg`; this one is a no-op if nothing was ever spawned
    /// (an attach never populates `pid`).
    pub fn shutdown(&mut self) {
        if let Some(pid) = self.pid {
            Spawner::kill(self, pid);
        }
    }
}

impl Spawner for ServerSpawner {
    fn spawn(&mut self) -> Result<u32, String> {
        let mut command = Command::new(&self.layout.server_binary);
        command
            .env("PLOTROOM_HOST", &self.host)
            .env("PLOTROOM_PORT", self.port.to_string())
            .env("PLOTROOM_STATE_DIR", &self.state_dir)
            // Threaded through so the server spawns *this* binary as its
            // session-host sidecar instead of resolving a workspace-relative
            // `@plotroom/session-host` package that a packaged app does not
            // ship (see `apps/server/src/config.ts`'s `PLOTROOM_SESSION_HOST`).
            .env("PLOTROOM_SESSION_HOST", &self.layout.session_host_binary)
            // The compiled server's own default static-dir resolution
            // (`../../web/dist` relative to its module URL) has no on-disk
            // sibling `apps/web` to find once it is a standalone
            // `bun build --compile` binary — without this the sidecar
            // answers every page request with the "no built renderer" 503
            // instead of serving the canvas.
            .env("PLOTROOM_STATIC_DIR", &self.layout.web_dist)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::inherit())
            .stderr(std::process::Stdio::inherit());

        unsafe {
            pre_exec_detach(&mut command);
        }

        let child = command
            .spawn()
            .map_err(|err: io::Error| format!("{err}"))?;
        let pid = child.id();
        self.child = Some(child);
        self.pid = Some(pid);
        Ok(pid)
    }

    fn kill(&mut self, pid: u32) {
        kill_process_group(pid);
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.child = None;
        self.pid = None;
    }
}

/// On Linux: put the child in its own process group (so a group-wide signal
/// never also hits this process) and arm `PR_SET_PDEATHSIG` so the kernel
/// kills the child itself the moment this process dies for *any* reason —
/// a crash, a forced quit, anything — closing the orphan risk #308's S2
/// spike measured directly (a plain spawned child survives its parent's
/// death, re-parented to init).
#[cfg(target_os = "linux")]
unsafe fn pre_exec_detach(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.pre_exec(|| {
        // New process group: `setpgid(0, 0)` makes this process its own
        // group leader, so `killpg` on it never reaches its parent (us).
        if libc::setpgid(0, 0) != 0 {
            return Err(io::Error::last_os_error());
        }
        // SIGKILL, not SIGTERM: an orphaned server sidecar holding the
        // operator's state-directory lock is worse than an ungraceful exit
        // of a process nothing is talking to anymore.
        if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
            return Err(io::Error::last_os_error());
        }
        // The parent may have exited in the window between fork and this
        // prctl call — re-check and self-kill rather than trust a signal
        // that could already have been missed.
        if libc::getppid() == 1 {
            libc::kill(0, libc::SIGKILL);
        }
        Ok(())
    });
}

/// On macOS and other non-Linux Unix: still moves the child into its own
/// process group, so `kill_process_group`'s `killpg` on our own shutdown
/// path (window closed, app quitting) reaches it. `PR_SET_PDEATHSIG` is a
/// Linux-only syscall — `libc` does not even declare it here — with no
/// drop-in equivalent (a `kqueue` `EVFILT_PROC`/`NOTE_EXIT` watch from the
/// child side is the closest analog and real added complexity, not a
/// one-line port). A sidecar orphaned by *this* process crashing (as
/// opposed to our own chosen shutdown, which does not depend on this at
/// all) is therefore a real, stated gap on macOS rather than a silently
/// claimed fix — recorded on #316 next to the Windows job-object gap below.
#[cfg(all(unix, not(target_os = "linux")))]
unsafe fn pre_exec_detach(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.pre_exec(|| {
        if libc::setpgid(0, 0) != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    });
}

/// A no-op stub on non-Unix platforms: Windows has no equivalent single
/// syscall, and its job-object-based alternative is unverified on this
/// container (no Windows hardware — recorded honestly on #316 rather than
/// guessed at here).
#[cfg(not(unix))]
unsafe fn pre_exec_detach(_command: &mut Command) {}

#[cfg(unix)]
fn kill_process_group(pid: u32) {
    unsafe {
        // Negative pid = the whole process group this sidecar leads (per
        // `setpgid` above), so a runaway grandchild it spawned goes down
        // with it too.
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_process_group(_pid: u32) {
    // Windows job objects would be the equivalent; unimplemented and
    // unverified on this container (no Windows hardware — see #316's PR).
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn dev_layout_points_at_each_apps_out_directory() {
        let layout = SidecarLayout::dev(Path::new("/repo"));
        assert_eq!(
            layout.server_binary,
            Path::new("/repo/apps/server/out/plotroom-server")
        );
        assert_eq!(
            layout.session_host_binary,
            Path::new("/repo/apps/session-host/out/plotroom-session-host")
        );
        assert_eq!(layout.web_dist, Path::new("/repo/apps/web/dist"));
    }

    #[cfg(unix)]
    #[test]
    fn a_spawned_child_does_not_survive_this_process_choosing_to_kill_it() {
        // Stands in for the real server binary the way #308's S2 spike used
        // `sleep 600` in place of the real session-host (which exits
        // immediately without valid auth): a long-running process spawned
        // through the exact same `Command` wiring this module uses.
        let mut command = Command::new("sleep");
        command.arg("30");
        unsafe {
            pre_exec_detach(&mut command);
        }
        let mut child = command.spawn().expect("failed to spawn stand-in child");
        let pid = child.id();

        // Give it a moment to actually start before tearing it down.
        std::thread::sleep(Duration::from_millis(50));
        kill_process_group(pid);
        let _ = child.wait();

        // If `killpg` worked, the pid is gone — `kill -0` (signal 0, a pure
        // existence probe) now fails.
        let still_alive = unsafe { libc::kill(pid as i32, 0) == 0 };
        assert!(!still_alive, "child pid {pid} survived its process group being killed");
    }
}
