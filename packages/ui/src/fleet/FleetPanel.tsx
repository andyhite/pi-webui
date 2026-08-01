/**
 * The Fleet panel (§8, §11): "today's total, the biggest spender, and
 * running sessions against the concurrency limit." Fed through
 * `FleetDataSource` — a one-shot load rather than a live subscription,
 * because nothing on main pushes a fleet-wide spend event yet (Track A's
 * Stage 2 gap, `types.ts`). A manual refresh button stands in for it.
 *
 * Unstyled: mechanics only until the design package lands (fleet rule 5).
 */

import { useEffect, useState } from "react";
import { formatMicros } from "@plotroom/core";

import type { FleetDataSource, FleetSummary } from "./types.js";

export interface FleetPanelProps {
  readonly dataSource: FleetDataSource;
}

export function FleetPanel({ dataSource }: FleetPanelProps) {
  const [summary, setSummary] = useState<FleetSummary | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void dataSource.load().then((next) => {
      if (!cancelled) {
        setSummary(next);
        setLoadedAt(Date.now());
      }
    });
    return () => {
      cancelled = true;
    };
  }, [dataSource]);

  function refresh(): void {
    void dataSource.load().then((next) => {
      setSummary(next);
      setLoadedAt(Date.now());
    });
  }

  if (!summary) return <div>loading fleet summary…</div>;

  return (
    <div data-testid="fleet-panel">
      <div>today's spend: {formatMicros(summary.todayTotalMicros)}</div>
      <div>
        biggest spender:{" "}
        {summary.biggestSpender
          ? `${summary.biggestSpender.sessionId} (${formatMicros(summary.biggestSpender.amountMicros)})`
          : "nobody has spent anything yet"}
      </div>
      <div>
        running: {summary.runningCount} of {summary.concurrencyLimit}
        {summary.queuedCount > 0 ? `, ${summary.queuedCount} queued` : ""}
      </div>
      <button type="button" onClick={refresh}>
        refresh
      </button>
      {loadedAt !== null ? (
        <div>last loaded {new Date(loadedAt).toLocaleTimeString()}</div>
      ) : null}
    </div>
  );
}
