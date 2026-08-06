// S2 spike (#308) continued: process-tree teardown / orphan risk.
// The real compiled session-host exits immediately without a valid model
// auth (see spawn-sidecar.mjs's captured fatal frame), so it can't stay
// alive long enough to observe orphaning. This uses a stand-in long-running
// child (`sleep 600`) spawned with the exact same child_process.spawn()
// wiring (a direct child, no process group, no PR_SET_PDEATHSIG) to isolate
// and demonstrate the OS-level risk that applies equally to the real binary:
// on Linux, a plain child of a plain child_process.spawn() (== a plain
// std::process::Command child on the Rust/Tauri side) is NOT killed when its
// parent dies. It is re-parented to init/systemd and keeps running.
import { spawn } from "node:child_process";

const child = spawn("sleep", ["600"], { stdio: "ignore" });
console.log(`ORPHAN_PARENT_PID=${process.pid}`);
console.log(`ORPHAN_CHILD_PID=${child.pid}`);
setInterval(() => {}, 1000);
