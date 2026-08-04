import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  buildSessionHostArgs,
  createOmpAdapter,
  systemMillisClock,
  OMP_ADAPTER_ID,
  type OmpConnect,
  type SessionHostProcess,
  type SessionRuntimeAdapter,
} from "@plotroom/core";
import type { Logger } from "../logging/logger.js";

/**
 * The session host, as a process the server owns (issue #73).
 *
 * `@plotroom/core` owns the argv, the framing and the lifecycle and takes the
 * live process as a dependency; this module is that dependency. Unlike the pi
 * adapter there is nothing else here — no generated extension, no file written
 * on every start — because the sidecar is ours and its behaviour is compiled in
 * rather than injected at launch.
 */
export const SESSION_HOST_ENTRY = "@plotroom/session-host/main";

export interface OmpRuntimeOptions {
  /**
   * PlotRoom's state directory. The SDK's own session files live under
   * `<stateDir>/runtime/`, which is derived state: the record PlotRoom reads is
   * the observation log (decision 0001), so nothing there is part of the backup
   * story (AGENTS.md).
   */
  readonly stateDir: string;
  /** A whole executable to run instead of this build's entry (issue #92). */
  readonly program?: string | null;
  /** The Bun program that runs this build's entry. */
  readonly bunProgram?: string;
  readonly logger?: Logger;
}

export function createOmpRuntime(
  options: OmpRuntimeOptions,
): SessionRuntimeAdapter {
  const sessionDir = join(options.stateDir, "runtime", "session-host");
  mkdirSync(sessionDir, { recursive: true });

  const connect: OmpConnect = async (launch) => {
    const hostArgs = buildSessionHostArgs(launch);
    const { program, args } =
      options.program === undefined || options.program === null
        ? {
            program: options.bunProgram ?? "bun",
            args: [resolveEntry(), ...hostArgs],
          }
        : { program: options.program, args: [...hostArgs] };

    options.logger?.info("spawning session host", {
      mode: launch.mode,
      model: launch.launch.model,
      cwd: launch.workspacePath,
      program,
    });

    const child = spawn(program, args, {
      cwd: launch.workspacePath,
      // The session host authenticates with the operator's own credential
      // store, like workspace git: PlotRoom injects nothing of its own.
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so an abort can signal the group and take a
      // runaway bash or browser child with it. Detached does not mean orphaned:
      // stdin is a pipe from this server, so a server that dies closes it and
      // the sidecar's own loop ends (POSIX; on Windows the group signal is
      // unavailable and the fallback reaches the sidecar alone).
      detached: true,
    });

    child.stderr.on("data", (chunk: Buffer) => {
      options.logger?.debug("session host stderr", {
        line: chunk.toString("utf8"),
      });
    });

    return new SessionHostChildProcess(child);
  };

  return createOmpAdapter({ connect, now: systemMillisClock, sessionDir });
}

export { OMP_ADAPTER_ID };

/**
 * Where this build keeps the session host.
 *
 * Resolved rather than imported: importing it would pull the agent SDK — a
 * native addon and hundreds of megabytes of it — into the server process, which
 * is the one thing the sidecar exists to avoid.
 *
 * Through `createRequire` rather than `import.meta.resolve`, which the test
 * runner's module transform does not provide — and a path that only works
 * outside the tests is one no test can prove. It resolves the package's
 * published entry (`dist/main.js`), so a session host whose source changed needs
 * a build before the server will spawn the change.
 */
function resolveEntry(): string {
  return createRequire(import.meta.url).resolve(SESSION_HOST_ENTRY);
}

class SessionHostChildProcess implements SessionHostProcess {
  readonly #child: ChildProcessWithoutNullStreams;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
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

  /**
   * A graceful close waits for the sidecar to leave after the `stop` command the
   * adapter already sent — that is what flushes the runtime's own session file,
   * so killing first would cost the resume point. A runtime that will not leave
   * must not hang the server either, so the wait is bounded and then it is an
   * abort: the stream has already ended from PlotRoom's point of view.
   */
  async close(mode: "graceful" | "abort"): Promise<void> {
    if (this.#child.exitCode !== null) return;

    if (mode === "graceful" && (await this.#waitForExit(GRACEFUL_EXIT_MS))) {
      return;
    }

    // The tree, not the process: an abort must take a runaway bash or browser
    // child with it, or the session is "stopped" while its work continues.
    this.#killTree();
    await this.#waitForExit(KILL_EXIT_MS);
  }

  #killTree(): void {
    const pid = this.#child.pid;
    if (pid === undefined) return;
    try {
      // A negative pid signals the process group, which the sidecar leads
      // because it was spawned detached. Where that is unavailable (Windows) or
      // the group has already gone, the fallback reaches the sidecar alone
      // rather than letting the failure escape into the server.
      process.kill(-pid, "SIGKILL");
    } catch {
      this.#child.kill("SIGKILL");
    }
  }

  async #waitForExit(withinMs: number): Promise<boolean> {
    if (this.#child.exitCode !== null) return true;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        resolve(false);
      }, withinMs);
      timer.unref();
      this.#child.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

const GRACEFUL_EXIT_MS = 10_000;
const KILL_EXIT_MS = 5_000;
