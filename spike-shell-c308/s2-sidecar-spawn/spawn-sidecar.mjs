// S2 spike (#308): spawn-or-attach mechanics for the compiled session-host
// binary treated as a Tauri sidecar candidate. Own throwaway dir, never
// touches apps/desktop production code.
//
// The compiled session-host (apps/session-host/src/main.ts) writes
// structured event frames to an extra file descriptor (FRAME_FD, fd 3)
// beyond stdio - see writeFrame() there. tauri-plugin-shell's sidecar
// Command::sidecar() helper only exposes stdin/stdout/stderr; plumbing fd 3
// through to a spawned process needs the same primitive Node's `stdio` array
// uses here (an extra fd slot), which on the Rust side means dropping to
// std::os::unix::process::CommandExt (pre_exec + dup2, or the `command-fds`
// crate) rather than the plugin's high-level sidecar() wrapper.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const BINARY = fileURLToPath(
  new URL("../../apps/session-host/out/plotroom-session-host", import.meta.url),
);

const child = spawn(
  BINARY,
  [
    "--cwd",
    "/tmp",
    "--session-dir",
    "/tmp/plotroom-spike-session-host",
    "--model",
    "spike/does-not-exist",
    "--effort",
    "low",
  ],
  {
    // fd 3 = the FRAME_FD channel session-host writes structured events to.
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  },
);

console.log(`SIDECAR_PARENT_PID=${process.pid}`);
console.log(`SIDECAR_CHILD_PID=${child.pid}`);

const frameFd = child.stdio[3];
let frameBuf = "";
frameFd.on("data", (d) => {
  frameBuf += d.toString("utf8");
  let idx;
  while ((idx = frameBuf.indexOf("\n")) >= 0) {
    const line = frameBuf.slice(0, idx);
    frameBuf = frameBuf.slice(idx + 1);
    console.log(`SIDECAR_FRAME=${line}`);
  }
});
child.stdout.on("data", (d) => process.stderr.write(`[sidecar stdout] ${d}`));
child.stderr.on("data", (d) => process.stderr.write(`[sidecar stderr] ${d}`));
child.on("exit", (code, signal) =>
  console.log(`SIDECAR_EXIT code=${code} signal=${signal}`),
);
child.on("error", (err) => console.log(`SIDECAR_SPAWN_ERROR=${err.message}`));

// Idle: this process plays the role of "the Tauri host process" for the
// orphan/teardown half of the spike (see README.md - `kill -9` this PID
// from a separate shell and check whether SIDECAR_CHILD_PID survives).
setInterval(() => {}, 1000);
