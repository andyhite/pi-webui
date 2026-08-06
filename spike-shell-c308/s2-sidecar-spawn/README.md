# S2 spike: session-host as a Tauri sidecar (#308)

Own throwaway dir, part of epic #304's shell-decision track (C: #308 -> #309).
Never touches `apps/desktop` production code. No Rust/Tauri process here -
the two mechanics S2 needs to prove (extra-fd IPC plumbing, and
process-tree teardown) are OS-level (Linux `fork`/`exec`/signals), so they
are demonstrated directly with Node's `child_process.spawn`, which uses the
identical primitives `std::process::Command` exposes on the Rust/Tauri side.
Where that matters, it's called out below.

## Scope note

The issue text describes S2 as "compiled Bun server + session-host binary as
Tauri sidecars". Only **session-host** currently has a compile step
(`apps/session-host`'s `compile` script, `bun src/compile.ts`) - the server
does not yet (`apps/server`'s `build` is still `tsc -b`; a compiled Bun
server is #314's job, still open at spike time). This spike therefore only
exercises session-host's real, already-existing compile pipeline; the
server-sidecar half is deferred to #314/#316 and not spiked here.

## What was run

```sh
cd apps/session-host && bun run compile
```

produced (Linux x64):

```
apps/session-host/out/plotroom-session-host              124MB
apps/session-host/out/pi_natives.linux-x64-baseline.node  155MB
apps/session-host/out/pi_natives.linux-x64-modern.node    155MB
```

**Finding 1 - the compiled artifact is a directory, not a lone binary.**
`compile.ts`'s own header comment explains why: the vendor SDK's native addon
does not survive `bun build --compile` and is staged beside the executable
instead, loaded from "the executable's own directory" at runtime. Tauri's
`bundle.externalBin` mechanism (per-target-triple sidecar binaries) expects a
single executable file per platform; the two ~155MB addon files would need to
travel as `bundle.resources` instead, co-located with the sidecar at runtime
(Tauri's resource dir and its externalBin dir are not guaranteed to be the
same one) - real wiring work for #316, not a blocker.

**Finding 2 - spawn + extra-fd IPC plumbing works, verified against the real
binary.** `apps/session-host/src/main.ts` writes structured JSON event
frames to `FRAME_FD` (fd 3), a channel beyond stdio. `spawn-sidecar.mjs`
spawns the real compiled binary with `stdio: ["ignore","pipe","pipe","pipe"]`
(fd 3 = a pipe) and captured a real frame over it:

```
SIDECAR_CHILD_PID=<pid>
SIDECAR_FRAME={"type":"fatal","message":"no authenticated model available for \"spike/does-not-exist\""}
SIDECAR_EXIT code=4 signal=null
```

The binary ran, parsed its args, and reported a real (expected - the spike
used a placeholder model) failure over the correct channel. This is the
proof: `tauri-plugin-shell`'s high-level `Command::sidecar()` helper only
exposes stdin/stdout/stderr, so wiring fd 3 on the Tauri side means dropping
to `std::os::unix::process::CommandExt` (`pre_exec` + `dup2`, or the
`command-fds` crate) rather than the plugin's sidecar wrapper - doable, just
not the one-liner the plugin advertises.

**Finding 3 - process-tree teardown is a real, unmitigated risk.** Because
the real binary exits immediately without valid model auth, orphaning was
demonstrated with a stand-in long-running child (`sleep 600`) spawned with
identical wiring (`orphan-test.mjs`) to isolate the OS-level behavior:

```
ORPHAN_PARENT_PID=<pid>   ORPHAN_CHILD_PID=<pid>
# kill -9 $ORPHAN_PARENT_PID
--- child still alive (orphaned)? ---
    PID PPID COMMAND
<pid>    1 sleep 600
```

Confirmed: a plain child of a plain `spawn()`/`std::process::Command` is
**not** killed when its parent dies on Linux - it is re-parented to init and
keeps running. This applies identically to a Tauri-spawned session-host
sidecar and must be handled explicitly in #316 (a process group + `killpg`
from the Rust side, or `PR_SET_PDEATHSIG` set in the child before `exec`) -
not a kill, but a named, real risk that would ship a resource leak if
skipped.

## Files

- `spawn-sidecar.mjs` - spawns the real compiled session-host with fd 3
  wired, captures its frame(s).
- `orphan-test.mjs` - stand-in long-lived child, used only for the teardown
  half (see Finding 3).

Neither script is a test suite; both are one-shot manual repros, run and
recorded on #308.
