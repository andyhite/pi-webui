import {
  parseSessionHostCommand,
  splitJsonLines,
  type EpochMillis,
  type SessionHostEvent,
} from "@plotroom/core";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import { createObservationTranslator } from "./observations.js";

/**
 * The part of the SDK's session this process drives.
 *
 * Structurally a subset of `AgentSession`, so the real thing is assignable and
 * the loop below is testable against a fake without a model, a provider, or a
 * native addon — which is what keeps the sidecar's own tests hermetic while the
 * SDK spike suite (issue #83) exercises the real surface.
 */
export interface HostedSession {
  readonly sessionFile: string | undefined;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(
    text: string,
    options?: { streamingBehavior?: "steer" },
  ): Promise<boolean>;
  /**
   * Winds the current turn down. Disposal is deliberately not here: the process
   * entry owns the session's lifetime, so the loop cannot end a session it did
   * not create and cannot dispose one twice.
   */
  abort(): Promise<void>;
}

export interface SessionHostOptions {
  readonly session: HostedSession;
  /** The native ref PlotRoom records — what resume is addressed by (§3.6). */
  readonly ref: string;
  readonly writeFrame: (frame: SessionHostEvent) => void;
  /** Raw stdin chunks; framing is this module's job, not the caller's. */
  readonly input: AsyncIterable<string>;
  readonly now: () => EpochMillis;
}

/**
 * One session, one process, one pipe.
 *
 * Resolves when PlotRoom asked the session to stop or when its stdin ended —
 * both of which mean the process should go. Everything the session does in
 * between leaves as an observation, and every command is acknowledged when it
 * has been taken into the runtime, never when it finished: a `prompt` that
 * resolved on turn completion would make "accepted" and "done" the same word.
 */
export async function runSessionHost(
  options: SessionHostOptions,
): Promise<void> {
  const { session, writeFrame, now } = options;
  const translator = createObservationTranslator();

  const unsubscribe = session.subscribe((event) => {
    for (const observation of translator.translate(event, now())) {
      writeFrame({ type: "observation", observation });
    }
  });

  writeFrame({ type: "ready", ref: options.ref });

  try {
    let buffer = "";
    for await (const chunk of options.input) {
      buffer += chunk;
      const { lines, rest } = splitJsonLines(buffer);
      buffer = rest;

      for (const line of lines) {
        const command = parseSessionHostCommand(line);
        if (command === null) {
          // PlotRoom is the only writer of this pipe and is typechecked against
          // the same types, so an unreadable line is a bug rather than input to
          // validate — and one that is reported instead of dropped, because a
          // command that vanished looks exactly like a session ignoring it.
          writeFrame({
            type: "observation",
            observation: {
              kind: "runtime-error",
              message: `the session host could not read a command: ${line.slice(0, 200)}`,
              fatal: false,
              at: now(),
            },
          });
          continue;
        }

        switch (command.type) {
          case "prompt":
            deliver(session, command.text, undefined, writeFrame, now);
            writeFrame({ type: "ack", id: command.id });
            break;

          case "inject":
            // §6.5. `streamingBehavior: "steer"` is the one shape that arrives in
            // both states a live session can be in: queued at the next turn
            // boundary while streaming, and consumed as a turn when idle.
            //
            // Acceptance is all that is acknowledged. Delivery is a separate
            // observed fact — `getQueuedMessages()` is what will report it, and
            // that is issue #82; `injectionId` rides the wire now so the frame
            // does not change when it lands.
            deliver(session, command.text, "steer", writeFrame, now);
            writeFrame({ type: "ack", id: command.id });
            break;

          case "respond":
            // Nothing raises a request yet: the permission gate and §6.4's
            // structured questions are issue #81, and they own the pending-call
            // registry an answer settles. Until then the truthful reply is that
            // there is nothing here to answer — never a silent success, which
            // would tell PlotRoom a blocked call had been released.
            writeFrame({
              type: "nack",
              id: command.id,
              error: `no request ${command.requestId} is pending in this session`,
            });
            break;

          case "stop":
            writeFrame({ type: "ack", id: command.id });
            await session.abort();
            return;
        }
      }
    }
  } finally {
    unsubscribe();
  }
}

/**
 * Hand input to the session without waiting for the turn it may start.
 *
 * `prompt()` resolves when the turn completes, so awaiting it here would hold
 * the command loop for the whole turn — no stop, no injection, no answer would
 * be read while the session was working. A rejection is reported as a
 * non-fatal runtime error: the turn failed, the session is still alive, and
 * PlotRoom decides what to do about it (§7.2).
 */
function deliver(
  session: HostedSession,
  text: string,
  streamingBehavior: "steer" | undefined,
  writeFrame: (frame: SessionHostEvent) => void,
  now: () => EpochMillis,
): void {
  const options = streamingBehavior === undefined ? {} : { streamingBehavior };
  void session.prompt(text, options).catch((error: unknown) => {
    writeFrame({
      type: "observation",
      observation: {
        kind: "runtime-error",
        message: error instanceof Error ? error.message : String(error),
        fatal: false,
        at: now(),
      },
    });
  });
}
