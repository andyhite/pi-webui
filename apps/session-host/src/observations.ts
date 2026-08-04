import type {
  EpochMillis,
  RuntimeObservation,
  TurnUsage,
} from "@plotroom/core";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";

/**
 * The SDK's events → PlotRoom's observations.
 *
 * This is the only source file in the product where vendor event names appear
 * (issue #73): the sidecar writes `RuntimeObservation` values it is typechecked
 * against, so a vendor release that renames an event costs one mapping change
 * here and no session records anywhere. The tests beside it name those events
 * too, and deliberately build their events as literals — so they would stay
 * green against a renamed SDK, and what catches a rename is the spike suite that
 * runs against the real thing on every pin bump (issue #83), never this file's
 * unit tests.
 *
 * It maps and never interprets. Phases are derived in `@plotroom/core` from
 * these observations plus PlotRoom's own approval, claim and silence state
 * (decision 0001) — so this file says what the runtime reported, never what the
 * session is doing.
 */
export interface ObservationTranslator {
  translate(
    event: AgentSessionEvent,
    at: EpochMillis,
  ): readonly RuntimeObservation[];
}

export function createObservationTranslator(): ObservationTranslator {
  let turn = 0;
  let turnOpen = false;

  return {
    translate(event, at) {
      switch (event.type) {
        case "turn_start": {
          turn += 1;
          turnOpen = true;
          return [{ kind: "turn-started", turn, at }];
        }

        case "turn_end": {
          // A `turn_end` with no turn open would renumber history: the reducer
          // pairs ends to starts by ordinal, and an unpaired end is an event
          // about a turn PlotRoom never saw begin.
          if (!turnOpen) return [];
          turnOpen = false;
          const usage = "usage" in event.message ? event.message.usage : null;
          const turnUsage: TurnUsage = {
            inputTokens: usage?.input ?? 0,
            outputTokens: usage?.output ?? 0,
            ...(usage === null ? {} : { cacheReadTokens: usage.cacheRead }),
            ...(usage === null ? {} : { cacheWriteTokens: usage.cacheWrite }),
            ...(usage === null ? {} : { costUsd: usage.cost.total }),
          };
          return [{ kind: "turn-ended", turn, usage: turnUsage, at }];
        }

        case "message_update": {
          const delta = event.assistantMessageEvent;
          if (delta.type === "text_delta") {
            return [{ kind: "output-delta", text: delta.delta, at }];
          }
          if (delta.type === "thinking_delta") {
            return [{ kind: "reasoning-delta", text: delta.delta, at }];
          }
          return [];
        }

        case "tool_execution_start":
          return [
            {
              kind: "tool-started",
              toolName: event.toolName,
              callId: event.toolCallId,
              input: event.args ?? null,
              at,
            },
          ];

        case "tool_execution_end":
          return [
            {
              kind: "tool-finished",
              callId: event.toolCallId,
              output: event.result ?? null,
              isError: event.isError ?? false,
              at,
            },
          ];

        case "auto_compaction_start":
          return [{ kind: "compaction-started", at }];

        case "auto_compaction_end":
          return [{ kind: "compaction-finished", at }];

        case "notice":
          // An error the runtime reported about itself. Non-fatal: it did not
          // end the session, and a stream that keeps producing observations
          // after one is a session still working (principle 12 — it is reported,
          // not swallowed).
          if (event.level !== "error") return [];
          return [
            {
              kind: "runtime-error",
              message:
                event.source === undefined
                  ? event.message
                  : `${event.source}: ${event.message}`,
              fatal: false,
              at,
            },
          ];

        default:
          // Everything else is the runtime's own business: model switches, todo
          // reminders, retry bookkeeping, IRC, goals. `agent_end` in particular
          // is deliberately not a `session-ended`: its `isTerminal: false` means
          // async delivery will resume the session, and PlotRoom's session ends
          // when the process does.
          return [];
      }
    },
  };
}
