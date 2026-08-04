import { LEVEL_RANK, type LogFields, type LogLevel } from "./logger.js";

/** One structured line, as `Logger` writes it, kept for a query rather than only stdout. */
export interface LogEntry {
  readonly time: string;
  readonly level: LogLevel;
  readonly msg: string;
  readonly component?: string;
  readonly fields: LogFields;
}

export interface StoredLogEntry extends LogEntry {
  readonly seq: number;
}

export interface LogQuery {
  /** At least this level (\u00a78's severity ordering), never an exact match only. */
  readonly level?: LogLevel;
  readonly component?: string;
  /** Exclusive: entries with `seq` greater than this. */
  readonly sinceSeq?: number;
  readonly limit?: number;
}

export interface LogQueryResult {
  readonly entries: readonly StoredLogEntry[];
  /**
   * How many entries have ever been evicted because the bound was reached —
   * "a bounded log sink must say it is bounded and report what it dropped,
   * not silently drop" (cross-cutting rule 5). Never resets: it is the whole
   * history of this process's drops, not a window.
   */
  readonly droppedTotal: number;
  readonly capacity: number;
  readonly oldestSeq: number | null;
  readonly newestSeq: number | null;
}

/**
 * A bounded, in-memory log sink (\u00a78, Epic 8.3): "a queryable structured-log
 * source" for the Logs panel, without ever growing unbounded or silently
 * losing what it evicts. Held for one process's lifetime — like the WS event
 * stream's `seq`, a restart starts a fresh buffer, and `GET /api/logs`
 * reflects only what this process itself has logged since it started (§8's
 * "viewable in the app", not a persisted archive).
 *
 * `push` is the only mutation; everything else is a read. Eviction is FIFO,
 * exactly like the ring its name promises: the oldest line goes first, and
 * `droppedTotal` is the running count of how many that has ever been.
 */
export class LogRingBuffer {
  private readonly entries: StoredLogEntry[] = [];
  private nextSeq = 1;
  private dropped = 0;

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error("LogRingBuffer capacity must be a positive integer");
    }
  }

  /** Returns the stored entry (with its assigned `seq`) and whether it evicted one. */
  push(entry: LogEntry): {
    readonly stored: StoredLogEntry;
    readonly evicted: boolean;
  } {
    const stored: StoredLogEntry = { ...entry, seq: this.nextSeq };
    this.nextSeq += 1;
    this.entries.push(stored);

    let evicted = false;
    if (this.entries.length > this.capacity) {
      this.entries.shift();
      this.dropped += 1;
      evicted = true;
    }
    return { stored, evicted };
  }

  get droppedTotal(): number {
    return this.dropped;
  }

  query(filter: LogQuery = {}): LogQueryResult {
    const minRank = filter.level ? LEVEL_RANK[filter.level] : 0;
    const matches = this.entries.filter(
      (entry) =>
        LEVEL_RANK[entry.level] >= minRank &&
        (filter.component === undefined ||
          entry.component === filter.component) &&
        (filter.sinceSeq === undefined || entry.seq > filter.sinceSeq),
    );

    const limit = filter.limit ?? 200;
    // The most recent `limit` matches, oldest-first, like a log tail rather
    // than a page one: a Logs panel wants what just happened, not page one of
    // everything since boot.
    const entries =
      matches.length > limit ? matches.slice(matches.length - limit) : matches;

    return {
      entries,
      droppedTotal: this.dropped,
      capacity: this.capacity,
      oldestSeq: this.entries[0]?.seq ?? null,
      newestSeq: this.entries.at(-1)?.seq ?? null,
    };
  }
}

/**
 * Five thousand lines: generous enough that an ordinary session's worth of
 * request and observation logs fits between two reads of the panel, bounded
 * enough that a busy fleet's stdout does not become an unbounded process-
 * lifetime array. There is no setting for this (yet) — see the batch report.
 */
export const DEFAULT_LOG_BUFFER_CAPACITY = 5_000;
