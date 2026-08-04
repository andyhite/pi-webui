import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addonFilesIn,
  refusedTheWorkerSelector,
  SessionHostCompileError,
  startedAndRefused,
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

describe("startedAndRefused", () => {
  const REFUSAL = '{"type":"fatal","message":"unknown session-host argument"}';

  it("accepts PlotRoom's own refusal, which only a started binary can write", () => {
    expect(startedAndRefused({ code: 2, stdout: REFUSAL, stderr: "" })).toBe(
      true,
    );
    expect(
      startedAndRefused({ code: 2, stdout: `${REFUSAL}\n`, stderr: "" }),
    ).toBe(true);
  });

  it("rejects a launch that never got as far as writing a frame", () => {
    // What a missing native addon looks like: the runtime dies before PlotRoom's
    // code runs, so there is no frame and the exit code is not the parser's.
    expect(
      startedAndRefused({ code: 1, stdout: "", stderr: "error: Failed to" }),
    ).toBe(false);
    expect(startedAndRefused({ code: 2, stdout: "", stderr: "" })).toBe(false);
  });

  it("rejects output that is not a frame, and a frame that is not fatal", () => {
    expect(
      startedAndRefused({ code: 2, stdout: "unknown flag\n", stderr: "" }),
    ).toBe(false);
    expect(startedAndRefused({ code: 2, stdout: "[1,2]", stderr: "" })).toBe(
      false,
    );
    expect(
      startedAndRefused({ code: 2, stdout: '{"type":"ready"}', stderr: "" }),
    ).toBe(false);
  });

  it("rejects a launch that was killed on the timeout", () => {
    // A hang is the failure the timeout exists for; a null code must never read
    // as health however the artifact's stdout looks.
    expect(startedAndRefused({ code: null, stdout: REFUSAL, stderr: "" })).toBe(
      false,
    );
  });
});

describe("refusedTheWorkerSelector", () => {
  it("catches the session parser answering a worker launch", () => {
    expect(
      refusedTheWorkerSelector({
        code: 2,
        stdout:
          '{"type":"fatal","message":"unknown session-host argument: __omp_worker_js_eval_process"}',
        stderr: "",
      }),
    ).toBe(true);
  });

  it("does not read a worker's own failure as the parser refusing", () => {
    // A worker that starts and then fails for its own reasons is not this
    // defect: the dispatch worked, and only the parser's sentence proves it did
    // not.
    expect(
      refusedTheWorkerSelector({
        code: 1,
        stdout: "",
        stderr: "no ipc channel",
      }),
    ).toBe(false);
  });
});
