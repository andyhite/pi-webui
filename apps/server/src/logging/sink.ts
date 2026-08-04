import type { LogFields, LogLevel, LogSink } from "./logger.js";
import type { LogRingBuffer } from "./ring-buffer.js";

export interface DropNotice {
  readonly droppedCount: number;
  readonly sinceSeq: number;
}

export interface BufferedSinkOptions {
  readonly logs: LogRingBuffer;
  /**
   * Called exactly once — the moment the buffer first starts dropping, never
   * again after (cross-cutting rule 5's "report what it dropped" without
   * flooding one event per line once the bound is reached; `GET /api/logs`'s
   * own `droppedTotal` is the running count from then on).
   */
  readonly onFirstDrop: (notice: DropNotice) => void;
  /** Where the line still goes, exactly as before this seam existed. */
  readonly write?: (line: string) => void;
}

/**
 * Wraps `Logger`'s own sink so every line still reaches stdout unchanged, and
 * also becomes queryable (§8, Epic 8.3) — without `Logger` itself knowing
 * anything about buffers or the event bus. `Logger` already emits one
 * well-formed JSON string per call; this is the one place that parses it back
 * apart, so the ring buffer is fed structured entries rather than restating
 * `Logger`'s own serialization.
 */
export function createBufferedSink(options: BufferedSinkOptions): LogSink {
  const write =
    options.write ?? ((line: string) => process.stdout.write(line + "\n"));

  return (line: string) => {
    write(line);

    const parsed = JSON.parse(line) as {
      readonly time: string;
      readonly level: LogLevel;
      readonly msg: string;
      readonly component?: string;
    } & LogFields;
    const { time, level, msg, component, ...fields } = parsed;

    const droppedBefore = options.logs.droppedTotal;
    options.logs.push({
      time,
      level,
      msg,
      ...(component !== undefined ? { component } : {}),
      fields,
    });

    if (droppedBefore === 0 && options.logs.droppedTotal > 0) {
      options.onFirstDrop({
        droppedCount: options.logs.droppedTotal,
        sinceSeq: options.logs.query().oldestSeq ?? 0,
      });
    }
  };
}
