/**
 * `@plotroom/plugin-git` — the Coding/git in-box plugin (§9.4).
 *
 * The default export is the manifest the host loads. This module is the only one in
 * the package that touches the machine: it supplies the command seam
 * (`node:child_process`), the clock, the disk probe, and directory removal, so every
 * other module is a pure description of git that a recorded fake can drive.
 *
 * The contract injects a log line and per-call credentials and nothing else — there
 * is no command capability in it — so a plugin that must run git brings its own
 * spawner. That is a finding the port reports, not a liberty it takes: the plugin's
 * filesystem and network reach is declared in its manifest, and v1 declares those
 * scopes rather than sandboxing them (`docs/plugin-contract.md` §3).
 */
import { spawn } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PluginManifest } from "@plotroom/plugin-sdk";

import type { GitExec } from "./exec.js";
import { createGitPlugin } from "./plugin.js";

/** No shell: an argument is an argument, never a fragment something reinterprets. */
export function nodeGitExec(): GitExec {
  return (command) =>
    new Promise((resolve, reject) => {
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

/**
 * Disk cost of a provisioned path (§3.4). Bounded on purpose: a deep walk of a fresh
 * checkout is slow, and an unknown cost is reported as unknown rather than as zero.
 */
export function nodeDiskUsage(
  maxEntries = 20_000,
): (path: string) => Promise<number | null> {
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
          if (seen > maxEntries) {
            return null;
          }
          const child = join(current, entry.name);
          if (entry.isDirectory()) {
            queue.push(child);
            continue;
          }
          if (!entry.isFile()) {
            continue;
          }
          bytes += (await stat(child)).size;
        }
      }
    } catch {
      return null;
    }
    return bytes;
  };
}

const manifest: PluginManifest = createGitPlugin({
  git: { exec: nodeGitExec(), hostEnvironment: process.env },
  clock: () => Date.now(),
  scratchDirectory: tmpdir(),
  diskUsage: nodeDiskUsage(),
  removeDirectory: (path) => rm(path, { recursive: true, force: true }),
});

export default manifest;

export { createGitPlugin, GIT_PLUGIN_ID } from "./plugin.js";
export type { GitPluginDeps } from "./plugin.js";
export type { GitExec, ShellCommand, CommandResult } from "./exec.js";
