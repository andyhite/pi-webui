import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A session host that speaks PlotRoom's frames and nothing else — no SDK, no
 * model. Its behaviour is chosen by the prompt text, which is how one script
 * covers every case that needs a *real* spawned process rather than the
 * scripted runtime's in-process double: `runtime/omp.test.ts`'s adapter-level
 * suite, and a shutdown that has to prove a session-host process is actually
 * gone (`runs/shutdown.integration.test.ts`, issue #71).
 *
 * Frames go to the frame channel, like the real one (issue #109) — the fd is
 * interpolated rather than written out, because a stand-in that agreed with an
 * older number would prove nothing about the server. `noisy-stdout` is the
 * case that used to corrupt them, and it now proves it cannot.
 */
export function standInSessionHostScript(frameFd: number): string {
  return `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, writeSync } from "node:fs";

const write = (frame) => {
  const bytes = Buffer.from(JSON.stringify(frame) + "\\n", "utf8");
  let written = 0;
  while (written < bytes.length) {
    written += writeSync(${frameFd}, bytes, written, bytes.length - written);
  }
};
const observe = (observation) => write({ type: "observation", observation });

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const command = JSON.parse(line);

    // Alive, reading, and answering nothing: the ready frame already went out,
    // so from outside this is a healthy session (issue #108).
    if (process.argv.includes("never-acks")) continue;

    if (command.type === "prompt") {
      if (command.text === "unauthenticated") {
        write({ type: "fatal", message: 'no authenticated model available for "stand-in"' });
        process.exit(4);
      }
      write({ type: "ack", id: command.id });
      if (command.text === "die") {
        process.exit(1);
      }
      if (command.text === "close-stdin") {
        // Alive, framing, and no longer reading: the next command PlotRoom writes
        // breaks the pipe. An interval keeps the process (and its stdout) up.
        setInterval(() => {}, 1000);
        process.stdin.destroy();
        closeSync(0);
        observe({ kind: "output-delta", text: "stdin-closed", at: Date.now() });
        continue;
      }
      if (command.text === "noisy-stdout") {
        // Exactly what the SDK's native addon does, and exactly where it used to
        // land: interleaved between two halves of a frame. On fd 3 it cannot,
        // because these two writes are not the same channel any more.
        const bytes = Buffer.from(JSON.stringify({
          type: "observation",
          observation: { kind: "output-delta", text: "survived", at: Date.now() },
        }) + "\\n", "utf8");
        const half = Math.floor(bytes.length / 2);
        writeSync(${frameFd}, bytes, 0, half);
        process.stdout.write("Downloading native addon...\\n");
        writeSync(1, Buffer.from("x".repeat(1_000_000), "utf8"));
        writeSync(${frameFd}, bytes, half, bytes.length - half);
        continue;
      }
      if (command.text === "spawn-child") {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          stdio: "ignore",
        });
        observe({ kind: "output-delta", text: "child-pid:" + child.pid, at: Date.now() });
        continue;
      }
      observe({ kind: "turn-started", turn: 1, at: Date.now() });
      observe({ kind: "output-delta", text: "done", at: Date.now() });
      observe({
        kind: "turn-ended",
        turn: 1,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
        at: Date.now(),
      });
      continue;
    }

    if (command.type === "stop") {
      write({ type: "ack", id: command.id });
      process.exit(0);
    }

    write({ type: "nack", id: command.id, error: "the stand-in does not do that" });
  }
});

// Two models select the two shapes of an alive, silent session host (issue #108).
// never-ready reports no session at all; never-acks reports one and then answers
// no command. Both are indistinguishable from a healthy start from outside,
// which is why the adapter has to bound the waits itself.
if (process.argv.includes("never-ready")) {
  setInterval(() => {}, 1000);
} else {
  write({ type: "ready", ref: "stand-in-session" });
}
`;
}

/**
 * Writes {@link standInSessionHostScript} into `dir` and marks it executable.
 * Returns the path, which is also this test process's unique handle on the
 * spawned OS process — a `pgrep -f <path>` (or an equivalent search) finds
 * exactly the one process this call produced, and only that one.
 */
export function writeStandInSessionHost(dir: string, frameFd: number): string {
  const path = join(dir, "stand-in-session-host.mjs");
  writeFileSync(path, standInSessionHostScript(frameFd), "utf8");
  chmodSync(path, 0o755);
  return path;
}

/**
 * Whether a process is gone.
 *
 * Polled against the real clock, which is the documented exception rather than
 * an oversight: process teardown is the operating system's, there is no signal
 * to await from outside the tree, and a re-parented grandchild is reaped a
 * moment after the group signal lands. Bounded, and a failure means it survived.
 */
export async function gone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 20);
    await promise;
  }
  return false;
}
