/**
 * The Logs panel (§8, §11, Epic 8.3): "a Logs panel over the structured
 * log, filtered." Level and component are both server-side filters
 * (`GET /api/logs`'s `level`/`component`), applied as soon as they change.
 *
 * Live-following is an **operator gesture**, not a background timer this
 * component starts on its own: the "follow" toggle below is what turns
 * polling on, and even then it is a bounded, `sinceSeq`-scoped read every
 * few seconds — never anything heavier, and never running while the toggle
 * is off. The `log` WS event carries only a drop notice (there is no
 * per-line event, by design), and receiving one triggers exactly one
 * bounded refetch — event-driven, not a second timer — so `droppedTotal`
 * is never stale for longer than that.
 *
 * `droppedTotal` is surfaced honestly whenever it is greater than zero
 * ("N entries dropped"), never silently (§8's own rule for a bounded sink).
 *
 * A read that *fails* is reported for the same reason: a fresh read replaces
 * the view, so its failure clears the rows and says so (stale rows would read
 * as the new filter's answer, and "no entries match this filter" is a claim a
 * failed read cannot make); an incremental follow poll only adds, so its
 * failure keeps the rows and says newer entries may be missing.
 *
 * Unstyled: mechanics only until the design package lands (fleet rule 5).
 */

import { useEffect, useRef, useState } from "react";

import { LiveRegion } from "../keyboard/LiveRegion.js";
import {
  LOG_LEVELS,
  type LogEntry,
  type LogLevel,
  type LogsDataSource,
} from "./types.js";

export interface LogsPanelProps {
  readonly dataSource: LogsDataSource;
}

/** How often the follow toggle polls, while it is on — a bounded `sinceSeq` read, never busier. */
const FOLLOW_INTERVAL_MS = 3_000;

interface LogsMeta {
  readonly droppedTotal: number;
  readonly capacity: number;
  readonly oldestSeq: number | null;
  readonly newestSeq: number | null;
}

const EMPTY_META: LogsMeta = {
  droppedTotal: 0,
  capacity: 0,
  oldestSeq: null,
  newestSeq: null,
};

export function LogsPanel({ dataSource }: LogsPanelProps) {
  const [level, setLevel] = useState<LogLevel | "">("");
  const [component, setComponent] = useState("");
  const [entries, setEntries] = useState<readonly LogEntry[]>([]);
  const [meta, setMeta] = useState<LogsMeta>(EMPTY_META);
  const [follow, setFollow] = useState(false);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filterRef = useRef({ level, component });
  filterRef.current = { level, component };
  const metaRef = useRef(meta);
  metaRef.current = meta;

  function baseQuery(sinceSeq?: number) {
    return {
      ...(filterRef.current.level ? { level: filterRef.current.level } : {}),
      ...(filterRef.current.component
        ? { component: filterRef.current.component }
        : {}),
      ...(sinceSeq !== undefined ? { sinceSeq } : {}),
    };
  }

  /**
   * A fresh read: it *replaces* what is on screen, so a failure means the
   * panel has nothing it can vouch for. The rows go and the failure is said
   * — left standing, the previous filter's rows read as this filter's, which
   * is the same lie as a silently truncated list (§8).
   */
  function reload(): void {
    void dataSource
      .query(baseQuery())
      .then((result) => {
        setError(null);
        setEntries(result.entries);
        setMeta({
          droppedTotal: result.droppedTotal,
          capacity: result.capacity,
          oldestSeq: result.oldestSeq,
          newestSeq: result.newestSeq,
        });
      })
      .catch((err: unknown) => {
        setEntries([]);
        setMeta(EMPTY_META);
        setError(err instanceof Error ? err.message : String(err));
      });
  }

  // Level/component change: a fresh, non-incremental read from the top.
  useEffect(() => {
    reload();
  }, [level, component, dataSource]);

  // The drop notice: one bounded refetch, never a timer of its own.
  useEffect(() => {
    return dataSource.subscribeDrop((drop) => {
      setAnnouncement(
        `${drop.droppedCount} entries dropped (before seq ${drop.sinceSeq}); the log is missing entries`,
      );
      reload();
    });
  }, [dataSource]);

  // The follow toggle: only while explicitly on, only a bounded sinceSeq read.
  useEffect(() => {
    if (!follow) return;
    const timer = setInterval(() => {
      const sinceSeq = metaRef.current.newestSeq ?? undefined;
      void dataSource
        .query(baseQuery(sinceSeq))
        .then((result) => {
          setError(null);
          if (result.entries.length > 0) {
            setEntries((current) => [...current, ...result.entries]);
          }
          setMeta({
            droppedTotal: result.droppedTotal,
            capacity: result.capacity,
            oldestSeq: result.oldestSeq ?? metaRef.current.oldestSeq,
            newestSeq: result.newestSeq ?? metaRef.current.newestSeq,
          });
        })
        // An incremental poll only ever *adds*, so a failure invalidates
        // nothing already read: the rows stay, `sinceSeq` does not advance,
        // and what is said is that newer lines may be missing. The toggle is
        // not turned off either — that is the operator's gesture, not a
        // transient failure's.
        .catch((err: unknown) => {
          setError(
            `${err instanceof Error ? err.message : String(err)} — newer entries may be missing`,
          );
        });
    }, FOLLOW_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [follow, dataSource]);

  return (
    <div data-testid="logs-panel">
      <label>
        level{" "}
        <select
          aria-label="log level filter"
          data-testid="logs-level-filter"
          value={level}
          onChange={(event) => setLevel(event.target.value as LogLevel | "")}
        >
          <option value="">all</option>
          {LOG_LEVELS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      <label>
        component{" "}
        <input
          aria-label="log component filter"
          data-testid="logs-component-filter"
          value={component}
          onChange={(event) => setComponent(event.target.value)}
        />
      </label>
      <button type="button" data-testid="logs-refresh" onClick={reload}>
        refresh
      </button>
      <button
        type="button"
        data-testid="logs-follow-toggle"
        aria-pressed={follow}
        onClick={() => setFollow((current) => !current)}
      >
        {follow ? "pause" : "follow"}
      </button>

      {error ? (
        <div data-testid="logs-error">could not read the log: {error}</div>
      ) : null}

      {meta.droppedTotal > 0 ? (
        <div data-testid="logs-dropped-banner">
          {meta.droppedTotal} entries dropped — the log is bounded and has lost
          some history
        </div>
      ) : null}

      <ul aria-label="log entries" data-testid="logs-entries">
        {entries.map((entry) => (
          <li key={entry.seq} data-testid={`log-entry-${entry.seq}`}>
            <span>{entry.time}</span> <strong>{entry.level}</strong>{" "}
            {entry.component ? <em>[{entry.component}]</em> : null}{" "}
            <span>{entry.msg}</span>
          </li>
        ))}
      </ul>
      {/* Only when a read actually answered: "nothing matches this filter" is
          a claim about the log, and a failed read is in no position to make
          it. */}
      {entries.length === 0 && error === null ? (
        <div>no log entries match this filter</div>
      ) : null}

      <LiveRegion
        // Said where a screen reader hears it, not only where it is drawn
        // (§11): rows vanishing, or quietly stopping, is a state change, and
        // one an operator cannot perceive is not reported at all. When both
        // are true the failure is the newer fact.
        message={error ? `could not read the log: ${error}` : announcement}
        label="logs status"
        testId="logs-panel-live-region"
      />
    </div>
  );
}
