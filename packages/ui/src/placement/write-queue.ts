/**
 * Durable placement, the write side (spec §5, §12): the API is the only
 * place a position lands now (Epic 3.1's deferral — "the renderer still
 * writes to localStorage" — closed by this seam replacing it in the live
 * path). A queue rather than a bare `fetch` per drag because several
 * gestures settling in quick succession (a fast series of small drags, a
 * palette drop right after a reset) must not turn into a burst of
 * overlapping requests that can land out of order; coalescing into one
 * write per quiet period is the "debounce sensibly" half of the deferral's
 * closing task. The other half — "never drop the final state" — is why
 * `pending` only ever *merges* (last write per id wins) and is never
 * cleared until a write for exactly that batch has actually gone out: a
 * flush that finds nothing pending is a no-op, never a silent drop.
 */

import type { Point } from "../solver/push.js";
import type { Placements } from "./store.js";

export interface ArrangementWriteResult {
  readonly ok: boolean;
  readonly refusal?: {
    readonly reason: string;
    readonly message: string;
  };
}

/**
 * A per-write escape hatch from the ordinary debounced flow (§5, §12): the
 * only member today is `keepalive`, for the one flush that must survive the
 * page tearing down around it (`apps/web/src/App.tsx`'s `pagehide`/
 * `visibilitychange` handling). Deliberately its own shape, not an import
 * of the HTTP transport's `RequestOptions` — this module's own
 * `ArrangementWriter` abstraction has no reason to know it is backed by
 * HTTP specifically, even though today it is (`actions.ts` satisfies both
 * shapes structurally, so nothing has to convert between them).
 */
export interface ArrangementWriteOptions {
  readonly keepalive?: boolean;
}

/** The two real endpoints (§5): one node, or a whole settled selection at once. */
export interface ArrangementWriter {
  setNodePosition(
    nodeId: string,
    position: Point,
    options?: ArrangementWriteOptions,
  ): Promise<ArrangementWriteResult>;
  setArrangement(
    positions: readonly { readonly nodeId: string; readonly position: Point }[],
    options?: ArrangementWriteOptions,
  ): Promise<ArrangementWriteResult>;
}

export interface ArrangementWriteQueueOptions {
  /** Quiet period before a pending batch is sent. Default 400ms. */
  readonly debounceMs?: number;
  /**
   * A write that came back refused, or threw — surfaced, never silently
   * ignored (the deferral's own closing requirement). Whatever a caller
   * does with it (log it, show it) is the caller's business; this queue's
   * only job is to guarantee it is told.
   */
  readonly onFailure: (
    result: ArrangementWriteResult,
    batch: Placements,
  ) => void;
  /** Injectable timer, so tests never wait on a real clock. */
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
}

export interface ArrangementWriteQueue {
  /** Merge a gesture's changed positions into whatever is already pending. */
  enqueue(delta: Placements): void;
  /**
   * Send whatever is pending right now, bypassing the debounce window —
   * for a caller that needs the guarantee before doing something else (a
   * page unload handler, a test assertion), not part of the ordinary flow.
   * `options` (today, only `keepalive`) passes straight through to the
   * `ArrangementWriter` call this makes — the ordinary debounced path
   * (`enqueue`'s own internal timer) never passes any, so nothing about
   * the everyday write changes.
   */
  flush(options?: ArrangementWriteOptions): Promise<void>;
}

export function createArrangementWriteQueue(
  writer: ArrangementWriter,
  options: ArrangementWriteQueueOptions,
): ArrangementWriteQueue {
  const debounceMs = options.debounceMs ?? 400;
  const scheduleTimeout = options.setTimeout ?? globalThis.setTimeout;
  const cancelTimeout = options.clearTimeout ?? globalThis.clearTimeout;

  let pending: Record<string, Point> = {};
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;

  function clearScheduled(): void {
    if (timer !== null) {
      cancelTimeout(timer);
      timer = null;
    }
  }

  async function flush(flushOptions?: ArrangementWriteOptions): Promise<void> {
    clearScheduled();
    const ids = Object.keys(pending);
    if (ids.length === 0) return;
    const batch = pending;
    pending = {};

    const entries = Object.entries(batch);
    const [first] = entries;
    // Omitted entirely rather than passed as an explicit `undefined` third
    // argument when nobody asked for `keepalive` — the ordinary debounced
    // flush's call to `writer` stays byte-for-byte what it was before this
    // option existed.
    const withOptions = flushOptions === undefined ? [] : [flushOptions];

    let result: ArrangementWriteResult;
    try {
      result =
        entries.length === 1 && first
          ? await writer.setNodePosition(first[0], first[1], ...withOptions)
          : await writer.setArrangement(
              entries.map(([nodeId, position]) => ({ nodeId, position })),
              ...withOptions,
            );
    } catch (err) {
      // A *thrown* write (a network failure, a 5xx, the server mid-restart)
      // is exactly the loss this queue's own doc comment forbids: `pending`
      // was already cleared above, so without this the batch is gone the
      // moment this rejects, `onFailure` never runs, and the drag the
      // operator just made vanishes with nothing to show for it (principles
      // 10/12). Put the whole batch back as retry material — merged *under*
      // whatever enqueued during the await, since a newer local value must
      // win over a stale one this attempt already failed to send — and
      // still tell the caller, exactly like a refusal does.
      pending = { ...batch, ...pending };
      options.onFailure(
        {
          ok: false,
          refusal: {
            reason: "write_failed",
            message: err instanceof Error ? err.message : String(err),
          },
        },
        batch,
      );
      return;
    }

    if (!result.ok) options.onFailure(result, batch);
  }

  return {
    enqueue(delta: Placements): void {
      if (Object.keys(delta).length === 0) return;
      pending = { ...pending, ...delta };
      clearScheduled();
      timer = scheduleTimeout(() => {
        timer = null;
        void flush();
      }, debounceMs);
    },
    flush,
  };
}
