/**
 * "What changed while I was away" (§7.3): each workstream's short, capped
 * event history, grouped by workstream so returning to one tells you what
 * happened in it specifically rather than a fleet-wide firehose. Selecting
 * an entry navigates the canvas the same way every other entry point does
 * (§5); a gone target renders as an honest tombstone rather than a dead
 * click (§7.3's "tolerates that target being gone").
 *
 * Fed through `ActivityDataSource` (`what-changed.ts`) — a one-shot load
 * rather than a live subscription, matching `FleetPanel`'s own pattern:
 * there is no incremental "activity" push channel (§7.3's history is
 * derived from records that already publish their own events elsewhere,
 * not a stream of its own), so a manual refresh stands in for one.
 *
 * Unstyled: mechanics only until the design package lands (fleet rule 5).
 */

import { useEffect, useState } from "react";

import {
  activityTargetExists,
  describeActivityTarget,
} from "./what-changed.js";
import type {
  ActivityDataSource,
  WorkstreamActivityEntry,
} from "./what-changed.js";

export interface WhatChangedPanelProps {
  readonly dataSource: ActivityDataSource;
  readonly workstreamNames: ReadonlyMap<string, string>;
  readonly nodeExists: (nodeId: string) => boolean;
  readonly onNavigate: (nodeId: string) => void;
}

export function WhatChangedPanel({
  dataSource,
  workstreamNames,
  nodeExists,
  onNavigate,
}: WhatChangedPanelProps) {
  const [history, setHistory] = useState<
    readonly WorkstreamActivityEntry[] | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    void dataSource.load().then((entries) => {
      if (!cancelled) setHistory(entries);
    });
    return () => {
      cancelled = true;
    };
  }, [dataSource]);

  function refresh(): void {
    void dataSource.load().then(setHistory);
  }

  if (history === null) return <div>loading what changed…</div>;

  const byWorkstream = new Map<string, WorkstreamActivityEntry[]>();
  for (const entry of history) {
    const list = byWorkstream.get(entry.workstreamId) ?? [];
    list.push(entry);
    byWorkstream.set(entry.workstreamId, list);
  }

  return (
    <div data-testid="what-changed">
      <button type="button" onClick={refresh}>
        refresh
      </button>
      {byWorkstream.size === 0 ? (
        <div data-testid="what-changed-empty">
          nothing changed while you were away
        </div>
      ) : (
        [...byWorkstream.entries()].map(([workstreamId, entries]) => (
          <section
            key={workstreamId}
            data-testid={`what-changed-${workstreamId}`}
          >
            <h3>{workstreamNames.get(workstreamId) ?? workstreamId}</h3>
            <ul
              aria-label={`what changed in ${
                workstreamNames.get(workstreamId) ?? workstreamId
              }`}
            >
              {entries.map((entry) => {
                const exists = activityTargetExists(entry, nodeExists);
                return (
                  <li key={entry.id}>
                    {entry.text} — {entry.kind}
                    {" — "}
                    {exists ? (
                      <button
                        type="button"
                        onClick={() => onNavigate(entry.targetNodeId)}
                      >
                        {describeActivityTarget(entry, nodeExists)}
                      </button>
                    ) : (
                      <span data-testid={`tombstone-${entry.id}`}>
                        {describeActivityTarget(entry, nodeExists)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
