/**
 * The structured log (§8, §11, Epic 8.3): "structured logs with a
 * consistent shape across the whole system, level adjustable at runtime,
 * sensitive values redacted, viewable in the app." The shape mirrors
 * `GET /api/logs` (`apps/server/src/routes/logs.ts`) field for field.
 */

import type { Unsubscribe } from "../data-source/types.js";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogEntry {
  readonly seq: number;
  readonly time: string;
  readonly level: LogLevel;
  readonly msg: string;
  readonly component?: string;
  /** Every other field the line carried — already redacted server-side. */
  readonly [field: string]: unknown;
}

export interface LogsQuery {
  /** "At least this level" (§8's severity ordering), never an exact match only. */
  readonly level?: LogLevel;
  readonly component?: string;
  /** Exclusive: entries with `seq` greater than this — the tail-follow cursor. */
  readonly sinceSeq?: number;
  readonly limit?: number;
}

export interface LogsResult {
  readonly entries: readonly LogEntry[];
  /** How many entries have ever been evicted — reported honestly, never silently (§8). */
  readonly droppedTotal: number;
  readonly capacity: number;
  readonly oldestSeq: number | null;
  readonly newestSeq: number | null;
}

/** What the `log` WS event carries (`@plotroom/core`'s `LogDropNotice`) — published only on a drop, never per line. */
export interface LogDropNoticeLike {
  readonly droppedCount: number;
  readonly sinceSeq: number;
}

export interface LogsDataSource {
  query(query: LogsQuery): Promise<LogsResult>;
  /** Fires only when the ring buffer starts dropping — there is no per-line event. */
  subscribeDrop(onDrop: (drop: LogDropNoticeLike) => void): Unsubscribe;
}
