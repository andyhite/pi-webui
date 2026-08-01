import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  createGitWorkspaceKind,
  systemMillisClock,
  WorkspaceKindRegistry,
} from "@plotroom/core";
import { nodeCommandExec, nodeDiskUsage, nodeWorkspaceFs } from "./exec.js";

/**
 * The workspace-kind registry the run path goes through (§3.4, §10.1).
 *
 * `@plotroom/core` owns the contract and the git implementation of it; this is
 * only the host wiring — a real process spawner, a real filesystem, a real
 * clock. A plugin-supplied kind (§10.1) registers here too, behind its worker
 * boundary, without the run path learning a second way to ask.
 */
export interface WorkspaceKindOptions {
  /** Somewhere to run commands that create their own target (clone). */
  readonly scratchDirectory?: string;
}

export function createWorkspaceKinds(
  options: WorkspaceKindOptions = {},
): WorkspaceKindRegistry {
  const registry = new WorkspaceKindRegistry();

  registry.register(
    createGitWorkspaceKind({
      exec: nodeCommandExec(),
      fs: nodeWorkspaceFs(),
      clock: systemMillisClock,
      // The host's own environment, allowlisted by `hostGitEnv` before git sees
      // any of it: app credentials never reach workspace git (§3.4, §9.3).
      hostEnvironment: process.env,
      scratchDirectory: options.scratchDirectory ?? tmpdir(),
      diskUsage: nodeDiskUsage(),
      removeDirectory: (path) => rm(path, { recursive: true, force: true }),
    }),
  );

  return registry;
}
