import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, afterEach, describe, it } from "bun:test";
import { FRAME_FD, OMP_ADAPTER_ID } from "../runtime/omp.js";
import {
  gone,
  writeStandInSessionHost,
} from "../testing/stand-in-session-host.js";
import {
  at,
  boot,
  cleanupHarnesses,
  command,
  repository,
} from "../testing/harness.js";

/**
 * Issue #71's worse half: an admission that slipped through a closing server
 * used to spawn a session-host process nothing ever tore down. This drives the
 * real `omp` adapter — a genuine child process, not the scripted runtime's
 * in-process double — because the claim under test ("no session-host process
 * survives `close()`") is a claim about the operating system, and only a real
 * process can be proven gone rather than merely "not referenced by JS anymore".
 */
afterEach(cleanupHarnesses);

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** The pid(s) of a process whose command line contains `needle`, from the OS itself. */
function pidsMatching(needle: string): readonly number[] {
  try {
    return execFileSync("pgrep", ["-f", needle], { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map(Number);
  } catch {
    // pgrep exits 1 when nothing matches — that is "no pids", not a failure.
    return [];
  }
}

describe("close() tears down every live session-host process (issue #71)", () => {
  it("kills a real, spawned session-host process rather than leaving it running past db.close()", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "plotroom-shutdown-child-"));
    scratch.push(workdir);
    // The sidecar's own path is unique to this test (a fresh tmpdir per run), so
    // a `pgrep -f` against it can only ever match the process this test spawned.
    const sidecar = writeStandInSessionHost(workdir, FRAME_FD);

    const harness = await boot({
      ...repository(),
      runtime: { adapterId: OMP_ADAPTER_ID, sessionHostProgram: sidecar },
    });

    const fixture = await command(harness);

    // `POST /runs` only answers once the adapter has a `ready` session and its
    // prompt is acknowledged (runtime-boundary.md §1–2) — both provably true
    // only once the child process exists, so the pid is there to find the
    // moment this resolves.
    const started = await harness.ok("/runs", {
      method: "POST",
      body: { commandId: fixture.commandId, initiationKey: "real-child-1" },
    });
    expect(at(started, "session.id")).toBeTruthy();

    const pids = pidsMatching(sidecar);
    expect(pids).toHaveLength(1);
    const pid = pids[0] as number;

    // Sanity: observed alive before it is asked to prove it is gone — a
    // `gone()` that always answered true would pass for the wrong reason.
    expect(await gone(pid)).toBe(false);

    await harness.handle.close();

    // The headline claim, checked two ways: `gone()` (a bounded `kill(pid, 0)`
    // poll, the same mechanism `runtime/omp.test.ts` uses for the adapter's own
    // process-teardown guarantees) and a second, independent `pgrep` — so this
    // is not "PlotRoom's own bookkeeping says it detached the handle", it is
    // "the operating system has no such process".
    expect(await gone(pid)).toBe(true);
    expect(pidsMatching(sidecar)).toHaveLength(0);
  }, 20_000);
});
