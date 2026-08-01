import type {
  EpochMillis,
  InjectionId,
  RuntimeObservation,
  TurnUsage,
} from "../../runtime.js";
import { parseGateRequest } from "./permission-gate.js";
import type { PiEvent, PiUsage } from "./protocol.js";

/**
 * pi's events → PlotRoom's observations (decision 0001).
 *
 * Phases are derived from these in core, so this file maps and never
 * interprets: it says what pi reported, not what the session is doing.
 */

export interface PendingInjection {
  readonly id: InjectionId;
  readonly text: string;
}

/**
 * pi's `queue_update` reports the steering queue's current contents, not the
 * message that left it. Delivery is therefore the difference: entries PlotRoom
 * queued that pi is no longer holding have been consumed at a turn boundary —
 * the §6.5 queued → delivered transition, observed rather than assumed.
 */
export function diffDeliveredInjections(
  pending: readonly PendingInjection[],
  steering: readonly string[],
): {
  readonly delivered: readonly InjectionId[];
  readonly remaining: readonly PendingInjection[];
} {
  const held = [...steering];
  const delivered: InjectionId[] = [];
  const remaining: PendingInjection[] = [];

  for (const injection of pending) {
    const index = held.indexOf(injection.text);
    if (index === -1) {
      delivered.push(injection.id);
    } else {
      held.splice(index, 1);
      remaining.push(injection);
    }
  }

  return { delivered, remaining };
}

export function toTurnUsage(usage: PiUsage | undefined): TurnUsage {
  const cost = usage?.cost?.total;
  return {
    inputTokens: usage?.input ?? 0,
    outputTokens: usage?.output ?? 0,
    ...(usage?.cacheRead === undefined
      ? {}
      : { cacheReadTokens: usage.cacheRead }),
    ...(usage?.cacheWrite === undefined
      ? {}
      : { cacheWriteTokens: usage.cacheWrite }),
    ...(cost === undefined ? {} : { costUsd: cost }),
  };
}

export interface PiObservationMapper {
  /** Record an injection pi accepted, so its delivery can be recognized later. */
  trackInjection(injection: PendingInjection): void;
  map(event: PiEvent, at: EpochMillis): readonly RuntimeObservation[];
  /** Injections pi is still holding — "queued" in the ledger's terms. */
  pending(): readonly PendingInjection[];
}

export function createPiObservationMapper(): PiObservationMapper {
  let turn = 0;
  let turnOpen = false;
  let pending: readonly PendingInjection[] = [];

  return {
    trackInjection(injection) {
      pending = [...pending, injection];
    },

    pending() {
      return pending;
    },

    map(event, at) {
      switch (event.type) {
        case "turn_start": {
          turn += 1;
          turnOpen = true;
          return [{ kind: "turn-started", turn, at }];
        }

        case "turn_end": {
          if (!turnOpen) return [];
          turnOpen = false;
          return [
            {
              kind: "turn-ended",
              turn,
              usage: toTurnUsage(event.message?.usage),
              at,
            },
          ];
        }

        case "message_update": {
          const delta = event.assistantMessageEvent;
          if (!delta) return [];
          if (delta.type === "text_delta" && delta.delta !== undefined) {
            return [{ kind: "output-delta", text: delta.delta, at }];
          }
          if (delta.type === "thinking_delta" && delta.delta !== undefined) {
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

        case "compaction_start":
          return [{ kind: "compaction-started", at }];

        case "compaction_end":
          return [{ kind: "compaction-finished", at }];

        case "queue_update": {
          const { delivered, remaining } = diffDeliveredInjections(
            pending,
            event.steering ?? [],
          );
          pending = remaining;
          return delivered.map((injectionId) => ({
            kind: "injection-delivered" as const,
            injectionId,
            at,
          }));
        }

        case "extension_ui_request": {
          const parsed = parseGateRequest(event);
          if (!parsed) return [];
          return [
            {
              kind: "request-raised",
              requestId: parsed.requestId,
              request: parsed.request,
              at,
            },
          ];
        }

        case "extension_error":
          return [
            {
              kind: "runtime-error",
              message: event.error ?? "extension error",
              fatal: false,
              at,
            },
          ];

        default:
          return [];
      }
    },
  };
}
