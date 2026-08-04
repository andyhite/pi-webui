import type { RuntimeObservation } from "../runtime.js";

/**
 * A minimal push queue, so observations stream without a dependency.
 *
 * Shared by every adapter: the stream's buffering behaviour is part of what
 * "the observation log is the record" means, and three copies of it would be
 * three chances for one runtime to drop an observation the others keep.
 */
export class ObservationQueue implements AsyncIterable<RuntimeObservation> {
  #buffer: RuntimeObservation[] = [];
  #waiting: ((value: IteratorResult<RuntimeObservation>) => void) | null = null;
  #done = false;

  push(observation: RuntimeObservation): void {
    if (this.#done) return;
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = null;
      waiting({ value: observation, done: false });
      return;
    }
    this.#buffer.push(observation);
  }

  end(): void {
    this.#done = true;
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = null;
      waiting({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeObservation> {
    return {
      next: (): Promise<IteratorResult<RuntimeObservation>> => {
        const next = this.#buffer.shift();
        if (next) return Promise.resolve({ value: next, done: false });
        if (this.#done) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.#waiting = resolve;
        });
      },
    };
  }
}
