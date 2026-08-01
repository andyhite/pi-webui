import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CommandExec, DiskUsageProbe, WorkspaceFs } from "@plotroom/core";

/**
 * The host side of `@plotroom/core`'s command and filesystem seams (§3.4).
 *
 * The domain describes the exact command to run and never spawns anything; this
 * is the module that does. It is deliberately small and dumb: no shell, no
 * environment of its own — the environment arrives fully built, because what a
 * workspace command may see is decided by `hostGitEnv` and nowhere else, which
 * is the shape of the host-auth invariant.
 */
export function nodeCommandExec(): CommandExec {
  return (command) =>
    new Promise((resolve, reject) => {
      // No shell: an argument is an argument, never a fragment of a command
      // line something else can reinterpret.
      const child = spawn(command.program, [...command.args], {
        cwd: command.cwd,
        env: { ...command.env },
        shell: false,
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", reject);
      child.on("close", (code) => {
        resolve({ exitCode: code ?? -1, stdout, stderr });
      });
    });
}

export function nodeWorkspaceFs(): WorkspaceFs {
  return {
    async readDirectory(path) {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        directory: entry.isDirectory(),
      }));
    },
  };
}

/**
 * Disk cost of a provisioned path (§3.4). Bounded on purpose: a deep walk of a
 * fresh checkout is slow, and an unknown cost is reported as unknown rather
 * than as zero.
 */
export function nodeDiskUsage(maxEntries = 20_000): DiskUsageProbe {
  return async (path) => {
    let bytes = 0;
    let seen = 0;
    const queue = [path];

    try {
      while (queue.length > 0) {
        const current = queue.pop() as string;
        const entries = await readdir(current, { withFileTypes: true });
        for (const entry of entries) {
          seen += 1;
          if (seen > maxEntries) return null;
          const child = join(current, entry.name);
          if (entry.isDirectory()) {
            queue.push(child);
            continue;
          }
          if (!entry.isFile()) continue;
          const info = await stat(child);
          bytes += info.size;
        }
      }
    } catch {
      return null;
    }

    return bytes;
  };
}
