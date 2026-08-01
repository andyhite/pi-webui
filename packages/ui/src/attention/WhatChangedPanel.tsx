/**
 * "What changed while I was away" (§7.3): each workstream's short, capped
 * event history, grouped by workstream so returning to one tells you what
 * happened in it specifically rather than a fleet-wide firehose. Selecting
 * an entry navigates the canvas the same way every other entry point does
 * (§5); a gone target renders as an honest tombstone rather than a dead
 * click (§7.3's "tolerates that target being gone").
 *
 * Unstyled: mechanics only until the design package lands (fleet rule 5).
 */

import {
  activityTargetExists,
  describeActivityTarget,
} from "./what-changed.js";
import type { WorkstreamActivityEntry } from "./what-changed.js";

export interface WhatChangedPanelProps {
  readonly history: readonly WorkstreamActivityEntry[];
  readonly workstreamNames: ReadonlyMap<string, string>;
  readonly nodeExists: (nodeId: string) => boolean;
  readonly onNavigate: (nodeId: string) => void;
}

export function WhatChangedPanel({
  history,
  workstreamNames,
  nodeExists,
  onNavigate,
}: WhatChangedPanelProps) {
  const byWorkstream = new Map<string, WorkstreamActivityEntry[]>();
  for (const entry of history) {
    const list = byWorkstream.get(entry.workstreamId) ?? [];
    list.push(entry);
    byWorkstream.set(entry.workstreamId, list);
  }

  if (byWorkstream.size === 0) {
    return (
      <div data-testid="what-changed-empty">
        nothing changed while you were away
      </div>
    );
  }

  return (
    <div data-testid="what-changed">
      {[...byWorkstream.entries()].map(([workstreamId, entries]) => (
        <section
          key={workstreamId}
          data-testid={`what-changed-${workstreamId}`}
        >
          <h3>{workstreamNames.get(workstreamId) ?? workstreamId}</h3>
          <ul>
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
      ))}
    </div>
  );
}
