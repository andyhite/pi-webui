import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildPiArgs,
  createPiAdapter,
  systemMillisClock,
  PI_ADAPTER_ID,
  PI_PERMISSION_GATE_EXTENSION,
  type PiConnect,
  type PiRpcTransport,
  type SessionRuntimeAdapter,
} from "@plotroom/core";
import type { Logger } from "../logging/logger.js";

/**
 * The pi coding agent, as a process the server owns (decision 0001, adapter v1).
 *
 * `@plotroom/core` has no knowledge of transport: it owns the argv
 * (`buildPiArgs`), the RPC framing, and the observation mapping, and takes the
 * live process as a dependency. This module is that dependency — spawn, stdio,
 * and the one file pi must load to make PlotRoom's per-call permission decision
 * enforceable rather than advisory (C6).
 */
export const PI_PROGRAM_DEFAULT = "pi";

export interface PiRuntimeOptions {
  /** Where the generated permission-gate extension is written. */
  readonly stateDir: string;
  readonly program?: string;
  readonly logger?: Logger;
}

export function createPiRuntime(
  options: PiRuntimeOptions,
): SessionRuntimeAdapter {
  const extensionPath = writePermissionGate(options.stateDir);

  const connect: PiConnect = async (launch) => {
    const args = buildPiArgs({ ...launch, extensionPaths: [extensionPath] });
    options.logger?.info("spawning pi", {
      mode: launch.mode,
      model: launch.launch.model,
      cwd: launch.workspacePath,
    });

    const child = spawn(options.program ?? PI_PROGRAM_DEFAULT, [...args], {
      cwd: launch.workspacePath,
      // pi authenticates with the host's own configuration, like workspace git:
      // PlotRoom never injects credentials of its own into a runtime.
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stderr.on("data", (chunk: Buffer) => {
      options.logger?.debug("pi stderr", { line: chunk.toString("utf8") });
    });

    return new PiProcessTransport(child, launch.ref ?? null);
  };

  return createPiAdapter({
    connect,
    now: systemMillisClock,
    extensionPaths: [extensionPath],
  });
}

export { PI_ADAPTER_ID };

/**
 * The gate runs inside pi's process, so it is shipped as source and written
 * beside the state directory. Regenerated on every start: a stale copy of the
 * gate is the one file that must never drift from the adapter that expects it.
 */
function writePermissionGate(stateDir: string): string {
  const dir = join(stateDir, "runtime");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "pi-permission-gate.mjs");
  writeFileSync(path, PI_PERMISSION_GATE_EXTENSION, "utf8");
  return path;
}

class PiProcessTransport implements PiRpcTransport {
  readonly ref: string;

  readonly #child: ChildProcessWithoutNullStreams;

  constructor(child: ChildProcessWithoutNullStreams, ref: string | null) {
    this.#child = child;
    // Until pi reports its own session id on the stream, the process identity
    // is what resume and fork are addressed by; it is persisted either way, so
    // replacing it with pi's own is a change of value, not of shape.
    this.ref = ref ?? `pi-${child.pid ?? "unknown"}`;
  }

  write(line: string): void {
    this.#child.stdin.write(line);
  }

  chunks(): AsyncIterable<string> {
    const child = this.#child;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const chunk of child.stdout) {
          yield (chunk as Buffer).toString("utf8");
        }
      },
    };
  }

  async close(mode: "graceful" | "abort"): Promise<void> {
    if (this.#child.exitCode !== null) return;

    // "graceful" lets pi wind down its turn; "abort" terminates. Both end the
    // observation stream, which is what the adapter turns into an end reason.
    this.#child.kill(mode === "graceful" ? "SIGTERM" : "SIGKILL");

    await new Promise<void>((resolve) => {
      this.#child.once("exit", () => resolve());
      // A runtime that will not die must not hang the server; the stream has
      // already ended from PlotRoom's point of view.
      setTimeout(resolve, 5_000).unref();
    });
  }
}
