import type { CommandExec, CommandResult } from "../exec.js";
import { hostGitEnv, redact } from "./host-auth.js";

/**
 * Running git.
 *
 * Every git invocation in this package goes through `runGit`, and `runGit`
 * takes no environment argument: the child's environment is built from the
 * host's by `hostGitEnv` and from nothing else. That is the shape of the
 * host-auth invariant (§3.4) — not a rule callers remember, but an argument
 * they cannot pass.
 */

export interface GitContext {
  readonly exec: CommandExec;
  /** The host's environment, filtered by allowlist before git sees any of it. */
  readonly hostEnvironment: Readonly<Record<string, string | undefined>>;
  /** The git binary; a host may keep it somewhere other than `PATH`. */
  readonly gitProgram?: string;
}

export interface GitInvocation {
  readonly cwd: string;
  readonly args: readonly string[];
}

export interface GitOutcome extends CommandResult {
  readonly args: readonly string[];
  readonly cwd: string;
}

export async function runGit(
  context: GitContext,
  invocation: GitInvocation,
): Promise<GitOutcome> {
  const result = await context.exec({
    program: context.gitProgram ?? "git",
    args: invocation.args,
    cwd: invocation.cwd,
    env: hostGitEnv(context.hostEnvironment),
  });
  return { ...result, args: invocation.args, cwd: invocation.cwd };
}

/** One line for the provisioning log, with nothing secret in it (§8). */
export function describeInvocation(outcome: GitOutcome): string {
  return `git ${outcome.args.map(redact).join(" ")} (in ${outcome.cwd}) → exit ${outcome.exitCode}`;
}

const AUTH_FAILURE_PATTERNS: readonly RegExp[] = [
  /permission denied \(publickey/iu,
  /authentication failed/iu,
  /could not read (?:username|password)/iu,
  /terminal prompts disabled/iu,
  /host key verification failed/iu,
  /access denied/iu,
  /repository not found/iu,
];

/**
 * Whether git failed because the host could not authenticate. It is reported as
 * its own provisioning failure so the operator sees "your machine cannot reach
 * this repository", and the product never answers it by reaching for a
 * credential of its own (§3.4).
 */
export function isHostAuthFailure(outcome: GitOutcome): boolean {
  if (outcome.exitCode === 0) return false;
  return AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(outcome.stderr));
}

export function gitFailureMessage(outcome: GitOutcome): string {
  const stderr = outcome.stderr.trim();
  const stdout = outcome.stdout.trim();
  const detail = stderr !== "" ? stderr : stdout;
  return `git ${outcome.args.map(redact).join(" ")} failed (exit ${outcome.exitCode})${
    detail === "" ? "" : `: ${detail}`
  }`;
}
