import type {
  RequestOutcome,
  RuntimeObservation,
  RuntimeRequestId,
  RuntimeSessionRef,
  SessionLaunchChoices,
} from "../../runtime.js";

/**
 * The wire between PlotRoom and its own session host (issue #73).
 *
 * Unlike the pi adapter, this is not a vendor protocol: `apps/session-host`
 * embeds the agent SDK and emits `RuntimeObservation` values it is typechecked
 * against, so no vendor event name crosses the process boundary. What is left
 * here is the envelope — enough to tell an observation from a command
 * acknowledgement, and enough to say the sidecar never started at all.
 *
 * One process per session. There is no session id on any frame because there is
 * nothing else on the pipe to confuse it with.
 */

/**
 * The private fd the frames travel over (issue #109), and the one place either
 * end learns the number.
 *
 * **Not stdout.** The sidecar embeds a vendor agent SDK whose native addon
 * prints, and a vendor write interleaving inside a frame corrupted it — the
 * adapter read an unparseable line and the observation vanished, in a system
 * whose record *is* the observation log. A channel nothing else holds removes
 * that rather than tolerating it.
 *
 * Here rather than in either end, because a server that spawned fd 3 and a
 * sidecar that wrote fd 4 would be a session host that reports nothing at all,
 * and both ends already import this package.
 */
export const FRAME_FD = 3;

/** Frames the sidecar writes to the frame channel, one JSON object per line. */
export type SessionHostEvent =
  /**
   * The native session exists and is addressable. Sent exactly once, before
   * anything else, because the ref is what resume and fork are addressed by and
   * a handle that reported the wrong one would be unresumable for ever.
   */
  | { readonly type: "ready"; readonly ref: RuntimeSessionRef }
  | { readonly type: "observation"; readonly observation: RuntimeObservation }
  /** A command was taken into the runtime — never that it finished. */
  | { readonly type: "ack"; readonly id: string }
  | { readonly type: "nack"; readonly id: string; readonly error: string }
  /**
   * The sidecar cannot run at all — no authenticated model, an unusable
   * workspace, a refused tool set. Distinct from a `runtime-error` observation
   * because there is no session for it to have happened to (§3.6: a session
   * record is only written for a session that started).
   */
  | { readonly type: "fatal"; readonly message: string }
  | { readonly type: "unknown" };

const EVENT_TYPES: Record<string, true> = {
  ready: true,
  observation: true,
  ack: true,
  nack: true,
  fatal: true,
};

/**
 * Parse one frame. An unreadable line is `unknown`, never a throw: a crash here
 * would take the session with it, and the rest of the stream is worth having.
 *
 * On a channel only PlotRoom writes, `unknown` no longer means "the sidecar
 * logged where it should have framed" — it means a frame arrived damaged and an
 * observation is gone. Which is why the adapter **reports** one rather than
 * dropping it (issue #109); this function's job is still only to refuse to
 * guess what the line was.
 */
export function parseSessionHostEvent(line: string): SessionHostEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { type: "unknown" };
  }

  if (typeof value !== "object" || value === null) return { type: "unknown" };
  if (!("type" in value) || typeof value.type !== "string") {
    return { type: "unknown" };
  }
  if (EVENT_TYPES[value.type] !== true) return { type: "unknown" };

  // The sidecar is typechecked against `RuntimeObservation`, so the shape is
  // guaranteed at build time on the writing side. What is checked here is that
  // the frame is one at all — a truncated line must not reach the reducer as an
  // observation with no `kind`.
  if (value.type === "observation") {
    const observation = "observation" in value ? value.observation : null;
    if (typeof observation !== "object" || observation === null) {
      return { type: "unknown" };
    }
    const kind = "kind" in observation ? observation.kind : null;
    const at = "at" in observation ? observation.at : null;
    if (typeof kind !== "string" || typeof at !== "number") {
      return { type: "unknown" };
    }
  }

  // Every discriminant the adapter branches on has now been checked, and the
  // payloads were written by a build that shares these types.
  const frame = value as SessionHostEvent;
  return frame;
}

/** Frames PlotRoom writes to the sidecar's stdin. */
export type SessionHostCommand =
  | { readonly type: "prompt"; readonly id: string; readonly text: string }
  | {
      readonly type: "inject";
      readonly id: string;
      readonly injectionId: string;
      readonly text: string;
    }
  | {
      readonly type: "respond";
      readonly id: string;
      readonly requestId: RuntimeRequestId;
      readonly outcome: RequestOutcome;
    }
  | {
      readonly type: "stop";
      readonly id: string;
      readonly mode: "graceful" | "abort";
    };

export function encodeSessionHostCommand(command: SessionHostCommand): string {
  return `${JSON.stringify(command)}\n`;
}

const COMMAND_TYPES: Record<string, true> = {
  prompt: true,
  inject: true,
  respond: true,
  stop: true,
};

/**
 * The sidecar's own reader, so both ends of the pipe agree on what a command is
 * in one place.
 *
 * `null` for a line the sidecar cannot read. PlotRoom is the only writer and is
 * typechecked against these types, so an unreadable line is a bug rather than
 * hostile input — but it is one the sidecar reports rather than crashes on,
 * because a session lost to a malformed frame is a session whose work is gone.
 */
export function parseSessionHostCommand(
  line: string,
): SessionHostCommand | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }

  if (typeof value !== "object" || value === null) return null;
  if (!("type" in value) || typeof value.type !== "string") return null;
  if (COMMAND_TYPES[value.type] !== true) return null;
  if (!("id" in value) || typeof value.id !== "string") return null;

  const command = value as SessionHostCommand;
  return command;
}

export type OmpLaunchMode = "start" | "resume" | "fork";

export interface OmpLaunchOptions {
  readonly mode: OmpLaunchMode;
  /** The native session to resume or fork from. Required for both, absent for `start`. */
  readonly ref?: RuntimeSessionRef;
  /**
   * The turn to fork through (§6.3), 1-based and inclusive. Required for
   * `fork`, absent otherwise — the sidecar resolves it against its own
   * forkable-message list, because only it can open the source session.
   */
  readonly through?: number;
  readonly launch: SessionLaunchChoices;
  /** Absolute path of the workspace the session may touch (§3.4). */
  readonly workspacePath: string;
  /**
   * Where the sidecar keeps the SDK's own session files. Derived state: the
   * record PlotRoom reads is the observation log (decision 0001), so this
   * directory is reconstructible and excluded from the backup story.
   */
  readonly sessionDir: string;
}

/**
 * The sidecar's argv, as a pure function so the mapping from per-session
 * choices (§3.6) to flags is testable without a process.
 *
 * The prompt is deliberately not here: assembled content (§3.5) routinely
 * exceeds what an argv can carry, so it arrives as a `prompt` command on the
 * pipe like every other input.
 */
export function buildSessionHostArgs(
  options: OmpLaunchOptions,
): readonly string[] {
  const args = [
    "--cwd",
    options.workspacePath,
    "--session-dir",
    options.sessionDir,
    "--model",
    options.launch.model,
    "--effort",
    options.launch.effort,
  ];

  const allowed = options.launch.toolPermissions.allowedTools;
  if (allowed !== null) {
    // A session is launched narrower than the app, never wider (§3.6). Absent,
    // the sidecar applies PlotRoom's pinned default set.
    args.push("--tools", allowed.join(","));
  }

  // A fork opens the source session exactly like a resume — `--resume` reuses
  // the same sidecar flag — and then rewinds it to `through` before the first
  // frame goes out (§6.3).
  if (
    (options.mode === "resume" || options.mode === "fork") &&
    options.ref !== undefined
  ) {
    args.push("--resume", options.ref);
  }
  if (options.mode === "fork" && options.through !== undefined) {
    args.push("--through", options.through.toString());
  }

  return args;
}
