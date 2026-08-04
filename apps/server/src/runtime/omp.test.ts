import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INHERIT_APP_TOOLS } from "@plotroom/core";
import type {
  RuntimeObservation,
  RuntimeSessionHandle,
  SessionRuntimeAdapter,
} from "@plotroom/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createOmpRuntime } from "./omp.js";

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

function runtime(): SessionRuntimeAdapter {
  return createOmpRuntime({ stateDir: workdir, program: sidecar });
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

  it("refuses to start when the session host says it cannot run", async () => {
    await expect(
      runtime().start({
        ...LAUNCH,
        prompt: "unauthenticated",
        workspacePath: workdir,
      }),
    ).rejects.toThrow("no authenticated model available");
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
 * the four cases above.
 */
const STAND_IN = `#!/usr/bin/env node
import { spawn } from "node:child_process";

const write = (frame) => process.stdout.write(JSON.stringify(frame) + "\\n");
const observe = (observation) => write({ type: "observation", observation });

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const lines = buffer.split("\\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const command = JSON.parse(line);

    if (command.type === "prompt") {
      if (command.text === "unauthenticated") {
        write({ type: "fatal", message: 'no authenticated model available for "stand-in"' });
        process.exit(4);
      }
      write({ type: "ack", id: command.id });
      if (command.text === "die") {
        process.exit(1);
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

write({ type: "ready", ref: "stand-in-session" });
`;
