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
  /**
   * True once pi has been *observed* holding this in its steering queue. The
   * distinction is what keeps delivery observed rather than guessed — see
   * `diffDeliveredInjections`. Absent means "not seen held yet".
   */
  readonly held?: boolean;
}

interface TrackedInjection extends PendingInjection {
  readonly held: boolean;
}

/**
 * pi's `queue_update` reports the steering queue's current contents, not the
 * message that left it. Delivery is therefore the difference: an entry PlotRoom
 * queued **that pi was seen holding**, and is no longer holding, has been
 * consumed at a turn boundary — the §6.5 queued → delivered transition, observed
 * rather than assumed.
 *
 * The "was seen holding" half is load-bearing. pi emits a `queue_update` the
 * moment it accepts a steering message, and again when the *follow-up* queue
 * changes — so an injection pi never queued at all (it was idle, and consumed the
 * input as a turn immediately) is absent from `steering` from the very first
 * update. Marking that delivered here would report delivery before the turn it
 * became had even started. Those are delivered on the next `turn-started`
 * instead, which is the first moment the input demonstrably became a turn.
 */
export function diffDeliveredInjections(
  pending: readonly PendingInjection[],
  steering: readonly string[],
): {
  readonly delivered: readonly InjectionId[];
  readonly remaining: readonly TrackedInjection[];
} {
  const held = [...steering];
  const delivered: InjectionId[] = [];
  const remaining: TrackedInjection[] = [];

  for (const injection of pending) {
    const index = held.indexOf(injection.text);
    if (index === -1) {
      if (injection.held === true) delivered.push(injection.id);
      else remaining.push({ ...injection, held: false });
      continue;
    }
    held.splice(index, 1);
    remaining.push({ ...injection, held: true });
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
          const started: RuntimeObservation[] = [
            { kind: "turn-started", turn, at },
          ];

          // An injection pi never queued was consumed as this turn's own input
          // (the idle path, §6.5): the turn starting is the observation that it
          // arrived. One PlotRoom injection can only ever be delivered once —
          // `markDelivered` ignores a second report — but keeping the ledger's
          // rule out of this file means not sending one either.
          const unqueued = pending.filter(
            (injection) => injection.held !== true,
          );
          pending = pending.filter((injection) => injection.held === true);
          for (const injection of unqueued) {
            started.push({
              kind: "injection-delivered",
              injectionId: injection.id,
              at,
            });
          }

          return started;
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
