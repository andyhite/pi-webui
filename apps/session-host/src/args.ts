import { SESSION_EFFORTS, type SessionEffort } from "@plotroom/core";

/**
 * What one session-host process was launched with.
 *
 * `buildSessionHostArgs` in `@plotroom/core` is the only writer of this argv, so
 * these two must be read together — but the parser refuses rather than
 * defaulting, because a sidecar that invented a model or a workspace would run
 * work nobody asked for.
 */
export interface SessionHostArgs {
  readonly cwd: string;
  readonly sessionDir: string;
  readonly model: string;
  readonly effort: SessionEffort;
  /** Null inherits PlotRoom's pinned set; a list narrows it (§3.6). */
  readonly toolNames: readonly string[] | null;
  /** The session file to reopen, for a resume. */
  readonly resume: string | null;
}

export class SessionHostArgsError extends Error {}

const FLAGS: Record<string, true> = {
  "--cwd": true,
  "--session-dir": true,
  "--model": true,
  "--effort": true,
  "--tools": true,
  "--resume": true,
};

export function parseSessionHostArgs(argv: readonly string[]): SessionHostArgs {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined) continue;
    if (FLAGS[flag] !== true) {
      throw new SessionHostArgsError(`unknown session-host argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined || FLAGS[value] === true) {
      throw new SessionHostArgsError(`${flag} needs a value`);
    }
    values.set(flag, value);
    index += 1;
  }

  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined) {
      throw new SessionHostArgsError(`${flag} is required`);
    }
    return value;
  };

  const cwd = required("--cwd");
  const sessionDir = required("--session-dir");
  const model = required("--model");
  const effort = required("--effort");

  if (!isSessionEffort(effort)) {
    throw new SessionHostArgsError(
      `--effort must be one of ${SESSION_EFFORTS.join(", ")}, got "${effort}"`,
    );
  }

  const tools = values.get("--tools");
  const toolNames =
    tools === undefined
      ? null
      : tools
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name.length > 0);

  if (toolNames !== null && toolNames.length === 0) {
    // "No tools at all" is a real launch choice elsewhere in the product, but it
    // is spelled by a command definition's declared permissions, not by an empty
    // flag that reads exactly like a formatting mistake.
    throw new SessionHostArgsError("--tools was empty");
  }

  return {
    cwd,
    sessionDir,
    model,
    effort,
    toolNames,
    resume: values.get("--resume") ?? null,
  };
}

function isSessionEffort(value: string): value is SessionEffort {
  return (SESSION_EFFORTS as readonly string[]).includes(value);
}
