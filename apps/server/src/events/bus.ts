import {
  newEventId,
  systemClock,
  type Clock,
  type DomainEvent,
  type DomainEventInput,
} from "@plotroom/core";

/**
 * The publication seam (Epic 2.1): Epic 2.2's mutations call {@link publish}
 * with a `DomainEventInput` (the typed vocabulary from `@plotroom/core`);
 * every WS subscriber — today the canvas, later the queue and agent tools —
 * receives the same assigned envelope (id, sequence, timestamp) over the
 * same stream. There is no second path a mutation can use to announce
 * itself; this bus *is* the one vocabulary in transport form.
 */
export type Unsubscribe = () => void;

export interface EventBus {
  publish(input: DomainEventInput): DomainEvent;
  subscribe(listener: (event: DomainEvent) => void): Unsubscribe;
  /** The sequence number that will be assigned to the next published event. */
  readonly nextSeq: number;
}

export function createEventBus(clock: Clock = systemClock): EventBus {
  const listeners = new Set<(event: DomainEvent) => void>();
  let seq = 0;

  return {
    publish(input) {
      seq += 1;
      const event: DomainEvent = {
        ...input,
        id: newEventId(),
        seq,
        occurredAt: clock(),
      };
      for (const listener of listeners) listener(event);
      return event;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get nextSeq() {
      return seq + 1;
    },
  };
}
