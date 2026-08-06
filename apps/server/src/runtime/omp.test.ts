import { expect } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INHERIT_APP_TOOLS } from "@plotroom/core";
import type {
  Delay,
  RuntimeObservation,
  RuntimeSessionHandle,
  SessionRuntimeAdapter,
} from "@plotroom/core";
import { afterAll, beforeAll, describe, it } from "bun:test";

import { createOmpRuntime, FRAME_FD } from "./omp.js";

/**
 * The process half of the seam, against a stand-in sidecar.
 *
 * The real one embeds the agent SDK, which needs Bun, a provider and a model —
 * proven separately by `omp.spike.test.ts`. What is under test here is what the
 * server owns: spawning, framing over real pipes, and the two stop modes,
 * including the one thing no unit test can show — that killing a session host
 * takes its own children with it and leaves the server serving.
 */
let workdir = "";
let sidecar = "";

const LAUNCH = {
  prompt: "do the thing",
  launch: {
    model: "stand-in",
    effort: "off",
    toolPermissions: INHERIT_APP_TOOLS,
  },
  workspacePath: "",
} as const;

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), "plotroom-session-host-"));
  sidecar = join(workdir, "stand-in-session-host.mjs");
  writeFileSync(sidecar, STAND_IN, "utf8");
  chmodSync(sidecar, 0o755);
});

afterAll(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

function runtime(delay?: Delay): SessionRuntimeAdapter {
  return createOmpRuntime({
    stateDir: workdir,
    program: sidecar,
    ...(delay === undefined ? {} : { delay }),
  });
}

/**
 * The adapter's own bound, capped so a suite need not wait for it.
 *
 * `Math.min`, not a constant: the adapter arms two bounds of different lengths
 * and a helper that returned one number for both would silently retune the other
 * one too.
 */
function shortened(ms: number, cap: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.min(ms, cap)).unref();
  });
}

async function drain(
  handle: RuntimeSessionHandle,
): Promise<readonly RuntimeObservation[]> {
  const stream: RuntimeObservation[] = [];
  for await (const observation of handle.observations()) {
    stream.push(observation);
  }
  return stream;
}

describe("the session host as a spawned process", () => {
  it("starts, streams, and stops on request", async () => {
    const handle = await runtime().start({ ...LAUNCH, workspacePath: workdir });
    const stream = drain(handle);

    expect(handle.ref).toBe("stand-in-session");

    await handle.stop("graceful");

    const observations = await stream;
    expect(observations.map((observation) => observation.kind)).toEqual([
      "turn-started",
      "output-delta",
      "turn-ended",
      "session-ended",
    ]);
    expect(observations.at(-1)).toMatchObject({
      kind: "session-ended",
      reason: { kind: "stopped", by: "user" },
    });
  }, 20_000);

  it("takes the session's own children with it on an abort", async () => {
    const handle = await runtime().start({
      ...LAUNCH,
      prompt: "spawn-child",
      workspacePath: workdir,
    });

    // The stand-in reports the pid of a grandchild that would otherwise outlive
    // it — a runaway bash or browser, in the real thing. Awaited off the stream
    // rather than polled for: the observation is the signal.
    const iterator = handle.observations()[Symbol.asyncIterator]();
    let child: number | null = null;
    while (child === null) {
      const next = await iterator.next();
      if (next.done === true) break;
      const observation = next.value;
      if (
        observation.kind === "output-delta" &&
        observation.text.startsWith("child-pid:")
      ) {
        child = Number(observation.text.slice("child-pid:".length));
      }
    }
    expect(child).not.toBe(null);

    await handle.stop("abort");

    expect(await gone(child ?? 0)).toBe(true);
  }, 20_000);

  it("survives a session host that dies unasked", async () => {
    const first = await runtime().start({
      ...LAUNCH,
      prompt: "die",
      workspacePath: workdir,
    });
    const stream = await drain(first);

    expect(stream.at(-1)).toMatchObject({
      kind: "session-ended",
      reason: { kind: "interrupted" },
    });

    // The server is still serving: the next session starts normally.
    const second = await runtime().start({ ...LAUNCH, workspacePath: workdir });
    expect(second.ref).toBe("stand-in-session");
    await second.stop("abort");
  }, 20_000);

  it("stops a session host that is already gone", async () => {
    const handle = await runtime().start({
      ...LAUNCH,
      prompt: "die",
      workspacePath: workdir,
    });
    await drain(handle);

    // A stop gesture can land after the sidecar died and before the driver
    // detaches its handle. It must finish rather than wait on an acknowledgement
    // nothing will send.
    await expect(handle.stop("graceful")).resolves.toBeUndefined();

    const next = await runtime().start({ ...LAUNCH, workspacePath: workdir });
    expect(next.ref).toBe("stand-in-session");
    await next.stop("abort");
  }, 20_000);

  it("survives writing to a session host that closed its stdin", async () => {
    // The narrower window the stdin `error` listener exists for: the sidecar is
    // alive, so its frame stream is open and the adapter still writes commands,
    // but nothing is reading the other end of the pipe. An unhandled `error` on
    // that stream is an uncaught exception, and the server would die because a
    // session host stopped listening.
    const handle = await runtime().start({
      ...LAUNCH,
      prompt: "close-stdin",
      workspacePath: workdir,
    });

    const iterator = handle.observations()[Symbol.asyncIterator]();
    let closed = false;
    while (!closed) {
      const next = await iterator.next();
      if (next.done === true) break;
      closed =
        next.value.kind === "output-delta" &&
        next.value.text === "stdin-closed";
    }
    expect(closed).toBe(true);

    // Never acknowledged, because nobody can read it. The write is the point.
    handle
      .inject({ id: "inj-1", text: "nobody is reading" })
      .catch(() => undefined);

    await handle.stop("abort");

    const next = await runtime().start({ ...LAUNCH, workspacePath: workdir });
    expect(next.ref).toBe("stand-in-session");
    await next.stop("abort");
  }, 20_000);

  it("refuses to start when the session host says it cannot run", async () => {
    await expect(
      runtime().start({
        ...LAUNCH,
        prompt: "unauthenticated",
        workspacePath: workdir,
      }),
    ).rejects.toThrow("no authenticated model available");
  }, 20_000);

  it("keeps a frame intact while the SDK floods stdout (issue #109)", async () => {
    const handle = await runtime().start({
      ...LAUNCH,
      prompt: "noisy-stdout",
      workspacePath: workdir,
    });

    // The stand-in writes half a frame, then a megabyte to stdout, then the
    // other half. A megabyte rather than "past 64KB": libuv gives spawned stdio
    // a socketpair whose capacity is `net.core.wmem_default` (212992 here) and
    // tunable, so a flood sized just over it goes vacuous on a tuned runner and
    // still passes — testing less, silently.
    const iterator = handle.observations()[Symbol.asyncIterator]();
    let text: string | null = null;
    while (text === null) {
      const next = await iterator.next();
      if (next.done === true) break;
      if (next.value.kind === "output-delta") text = next.value.text;
      // A frame damaged by the flood would arrive as this instead, which is what
      // the shared channel produced and what fd 3 makes impossible.
      expect(next.value.kind).not.toBe("runtime-error");
    }

    expect(text).toBe("survived");

    await handle.stop("abort");
  }, 20_000);

  it("answers rather than hanging when the session host never reports a session (issue #108)", async () => {
    // A real bound, deliberately: an instantly-expiring one would reject a
    // *healthy* start too, and a test that cannot tell the two apart proves only
    // that the bound fires. Two seconds is the documented real-clock exception
    // this file already takes for `gone()` — process startup is the operating
    // system's, and the launches above settle in tens of milliseconds.
    const bounded = runtime((ms) => shortened(ms, 2_000));

    // Started, alive, framing nothing: indistinguishable from a healthy start
    // from outside, which is why nothing above the adapter could escalate.
    await expect(
      bounded.start({
        ...LAUNCH,
        launch: { ...LAUNCH.launch, model: "never-ready" },
        workspacePath: workdir,
      }),
    ).rejects.toThrow(/did not report a session within/);

    // The other direction, under the same bound: a sidecar that does report one
    // is not refused. Without this the assertion above passes for any bound at
    // all, including one that fires before the process has spawned.
    const healthy = await bounded.start({ ...LAUNCH, workspacePath: workdir });
    expect(healthy.ref).toBe("stand-in-session");
    await healthy.stop("abort");
  }, 20_000);

  it("answers rather than hanging when the session host never acknowledges (issue #108)", async () => {
    // The other half of the hang, and the one a ready bound alone does not reach:
    // `ready` arrives, so the adapter has a session — and then `open()` awaits the
    // prompt's acknowledgement, which never comes.
    const bounded = runtime((ms) => shortened(ms, 2_000));

    await expect(
      bounded.start({
        ...LAUNCH,
        launch: { ...LAUNCH.launch, model: "never-acks" },
        workspacePath: workdir,
      }),
    ).rejects.toThrow(/did not acknowledge a prompt command within/);

    // Same bound, healthy sidecar: not refused. Without this the assertion above
    // passes for a bound that fires before the prompt was ever written.
    const healthy = await bounded.start({ ...LAUNCH, workspacePath: workdir });
    expect(healthy.ref).toBe("stand-in-session");
    await healthy.stop("abort");
  }, 20_000);
});

/**
 * Whether a process is gone.
 *
 * Polled against the real clock, which is the documented exception rather than
 * an oversight: process teardown is the operating system's, there is no signal
 * to await from outside the tree, and a re-parented grandchild is reaped a
 * moment after the group signal lands. Bounded, and a failure means it survived.
 */
async function gone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

/**
 * A session host that speaks PlotRoom's frames and nothing else — no SDK, no
 * model. Its behaviour is chosen by the prompt, which is how one script covers
 * every case above.
 *
 * Frames go to the frame channel, like the real one (issue #109) — the fd is
 * interpolated rather than written out, because a stand-in that agreed with an
 * older number would prove nothing about the server. `noisy-stdout` is the case
 * that used to corrupt them, and it now proves it cannot.
 */
const STAND_IN = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, writeSync } from "node:fs";

const write = (frame) => {
  const bytes = Buffer.from(JSON.stringify(frame) + "\\n", "utf8");
  let written = 0;
  while (written < bytes.length) {
    written += writeSync(${FRAME_FD}, bytes, written, bytes.length - written);
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
        writeSync(${FRAME_FD}, bytes, 0, half);
        process.stdout.write("Downloading native addon...\\n");
        writeSync(1, Buffer.from("x".repeat(1_000_000), "utf8"));
        writeSync(${FRAME_FD}, bytes, half, bytes.length - half);
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
