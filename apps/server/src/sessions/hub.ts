import type { RuntimeSessionHandle } from "@plotroom/core";

/**
 * The live runtime handles, by session id.
 *
 * A session record survives a restart; a *handle* does not — it is the live
 * process. Keeping the two apart is what makes principle 11 implementable: at
 * the next start the records are still there, the handles are gone, and every
 * session that was in flight is marked interrupted rather than believed to be
 * running.
 */
export interface LiveSession {
  readonly handle: RuntimeSessionHandle;
  readonly adapterId: string;
  /** Resolves when the observation pump has finished draining the stream. */
  readonly pump: Promise<void>;
}

export class SessionHub {
  readonly #live = new Map<string, LiveSession>();

  attach(sessionId: string, live: LiveSession): void {
    this.#live.set(sessionId, live);
  }

  get(sessionId: string): LiveSession | null {
    return this.#live.get(sessionId) ?? null;
  }

  ids(): readonly string[] {
    return [...this.#live.keys()];
  }

  detach(sessionId: string): void {
    this.#live.delete(sessionId);
  }

  /**
   * Let go of every live session without ending it. Called when the server is
   * shutting down: the records stay in flight on purpose, so the next start
   * records them as **interrupted** — not stopped, and not failed (principle 11).
   */
  detachAll(): void {
    this.#live.clear();
  }
}
