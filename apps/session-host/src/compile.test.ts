import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addonFilesIn,
  dispatchedTheWorker,
  SessionHostCompileError,
  startedAndRefused,
  type SmokeLaunch,
} from "./compile.js";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "plotroom-addon-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("addonFilesIn", () => {
  it("takes every addon variant, because the running CPU picks one", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "pi_natives.linux-x64-modern.node"), "");
    writeFileSync(join(directory, "pi_natives.linux-x64-baseline.node"), "");
    writeFileSync(join(directory, "package.json"), "{}");

    expect(addonFilesIn(directory)).toEqual([
      "pi_natives.linux-x64-baseline.node",
      "pi_natives.linux-x64-modern.node",
    ]);
  });

  it("refuses a directory holding no addon at all", () => {
    // A compiled binary loads its addon from beside itself, so staging nothing is
    // an artifact that dies on its first launch. Refusing here is the difference
    // between a named failure and a green build.
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "package.json"), "{}");

    expect(() => addonFilesIn(directory)).toThrow(SessionHostCompileError);
  });
});

/** One launch, stating only what the test varies. */
function launch(over: Partial<SmokeLaunch> = {}): SmokeLaunch {
  return {
    running: false,
    code: 2,
    frames: "",
    stdout: "",
    stderr: "",
    ...over,
  };
}

describe("startedAndRefused", () => {
  const REFUSAL = '{"type":"fatal","message":"unknown session-host argument"}';

  it("accepts PlotRoom's own refusal, which only a started binary can write", () => {
    expect(startedAndRefused(launch({ frames: REFUSAL }))).toBe(true);
    expect(startedAndRefused(launch({ frames: `${REFUSAL}\n` }))).toBe(true);
  });

  it("refuses a binary that framed to stdout instead of fd 3 (issue #109)", () => {
    // The regression this check now catches: the artifact started and refused,
    // and every byte of it went to the channel the SDK also prints to. That is
    // the corruption issue #109 removed, so an artifact still doing it is not a
    // healthy one however correct its sentence reads.
    expect(startedAndRefused(launch({ stdout: REFUSAL }))).toBe(false);
  });

  it("rejects a launch that never got as far as writing a frame", () => {
    // What a missing native addon looks like: the runtime dies before PlotRoom's
    // code runs, so there is no frame and the exit code is not the parser's.
    expect(
      startedAndRefused(launch({ code: 1, stderr: "error: Failed to" })),
    ).toBe(false);
    expect(startedAndRefused(launch())).toBe(false);
  });

  it("rejects output that is not a frame, and a frame that is not fatal", () => {
    expect(startedAndRefused(launch({ frames: "unknown flag\n" }))).toBe(false);
    expect(startedAndRefused(launch({ frames: "[1,2]" }))).toBe(false);
    expect(startedAndRefused(launch({ frames: '{"type":"ready"}' }))).toBe(
      false,
    );
  });

  it("rejects a launch that was killed on the timeout", () => {
    // A hang is the failure the timeout exists for; a null code must never read
    // as health however the artifact's frames look.
    expect(
      startedAndRefused(launch({ running: true, code: null, frames: REFUSAL })),
    ).toBe(false);
  });
});

describe("dispatchedTheWorker", () => {
  it("passes a launch still waiting for the IPC peer it was never given", () => {
    // Killed at the bound, which is what a dispatched worker looks like: it has
    // nothing to say and nothing to exit for.
    expect(dispatchedTheWorker(launch({ running: true, code: null }))).toBe(
      true,
    );
  });

  it("fails the session parser answering a worker launch", () => {
    expect(
      dispatchedTheWorker(
        launch({
          frames:
            '{"type":"fatal","message":"unknown session-host argument: __omp_worker_js_eval_process"}',
        }),
      ),
    ).toBe(false);
  });

  it("fails every other early exit, whatever it says", () => {
    // A selector the SDK's dispatcher no longer knows (exit 1 on stderr), and a
    // handover that left through `process.exit` with nothing written (exit 0):
    // both are workers that never ran, and neither writes the parser's sentence.
    expect(
      dispatchedTheWorker(
        launch({
          code: 1,
          stderr:
            "Error: unknown worker selector: __omp_worker_js_eval_process",
        }),
      ),
    ).toBe(false);
    expect(dispatchedTheWorker(launch({ code: 0 }))).toBe(false);

    // The reason `running` is carried rather than derived: a worker that died on
    // a signal reports no exit code either, and reading "no code" as "we killed
    // it at the bound" would pass a crash.
    expect(
      dispatchedTheWorker(launch({ code: null, stderr: "Segmentation fault" })),
    ).toBe(false);
  });
});
