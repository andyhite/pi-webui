/**
 * The command seam.
 *
 * Workspace mechanics are the one part of the product that must touch a real
 * machine — git, a setup step, a disk measurement. `@plotroom/core` stays free
 * of transport (decision 0001), so nothing here spawns anything: the domain
 * describes the exact command to run and a host-supplied `CommandExec` runs it.
 * Unit tests pass a recording fake and stay hermetic; the server passes a
 * process spawner; the integration tests pass a real one against temp
 * directories.
 */

import type { EpochMillis } from "../sessions/runtime.js";

/**
 * Milliseconds since the epoch. The package has one timestamp vocabulary and
 * one module owns it (`sessions/runtime.ts`); workspaces re-use the type rather
 * than declaring a second one that means the same thing.
 */
export type { EpochMillis };

/** Time as a dependency, at the resolution provisioning cost is reported in. */
export type MillisClock = () => EpochMillis;

export const systemMillisClock: MillisClock = () => Date.now();

export interface ShellCommand {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /**
   * The complete environment for the child. It is a full replacement, never a
   * patch over the parent's: what a workspace command may see is decided here
   * and nowhere else (`hostGitEnv`), which is what makes the host-auth
   * invariant checkable (§3.4).
   */
  readonly env: Readonly<Record<string, string>>;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandExec = (command: ShellCommand) => Promise<CommandResult>;

/**
 * Disk cost of a provisioned path (§3.4, "reports what provisioning cost").
 * Null when the host cannot measure it — an unknown cost is reported as
 * unknown rather than as zero.
 */
export type DiskUsageProbe = (path: string) => Promise<number | null>;
