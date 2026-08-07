import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INHERIT_APP_TOOLS } from "@plotroom/core";
import type {
  Delay,
  RuntimeObservation,
  RuntimeSessionHandle,
  SessionRuntimeAdapter,
} from "@plotroom/core";
import { expect, afterAll, beforeAll, describe, it } from "bun:test";

import { createOmpRuntime, FRAME_FD } from "./omp.js";
import {
  gone,
  writeStandInSessionHost,
} from "../testing/stand-in-session-host.js";

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
  sidecar = writeStandInSessionHost(workdir, FRAME_FD);
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
