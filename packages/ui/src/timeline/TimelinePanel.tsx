/**
 * The Timeline panel (§8, §11): "a session's turn-by-turn breakdown" —
 * "including for finished sessions, so it is the post-mortem for something
 * that failed overnight." Fed directly from `GET /api/sessions/:id/
 * observations` (already live on main; decision 0001's own observation
 * log), through `buildTimelineLayout`'s pure time-proportional math.
 *
 * Unstyled: mechanics only until the design package lands (fleet rule 5).
 * Segment width is an inline `style` percentage — mechanics, not a design
 * decision — because a time-proportional layout has no other honest way to
 * express "this took a third of the session" without measuring time.
 */

import { useEffect, useState } from "react";

import type { HttpClient } from "../transport/http.js";
import { buildTimelineLayout } from "./layout.js";
import type { TimelineLayout } from "./layout.js";
import type { RuntimeObservation } from "@plotroom/core";

export interface TimelinePanelProps {
  readonly sessionId: string;
  readonly http: HttpClient;
}

export function TimelinePanel({ sessionId, http }: TimelinePanelProps) {
  const [layout, setLayout] = useState<TimelineLayout | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLayout(null);
    void http
      .get<{
        readonly observations: readonly {
          readonly observation: RuntimeObservation;
        }[];
      }>(`/api/sessions/${encodeURIComponent(sessionId)}/observations`)
      .then((response) => {
        if (cancelled) return;
        setLayout(
          buildTimelineLayout(response.observations.map((r) => r.observation)),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, http]);

  if (!layout) return <div>loading timeline…</div>;
  if (layout.segments.length === 0) {
    return <div data-testid="timeline-empty">nothing recorded yet</div>;
  }

  return (
    <div data-testid="timeline-panel">
      <div>
        {new Date(layout.startAt).toLocaleTimeString()} –{" "}
        {new Date(layout.endAt).toLocaleTimeString()}
      </div>
      <ul style={{ position: "relative", listStyle: "none", padding: 0 }}>
        {layout.segments.map((segment) => (
          <li
            key={`${segment.kind}-${segment.id}`}
            data-testid={`timeline-segment-${segment.kind}-${segment.id}`}
            style={{
              marginLeft: `${(segment.startFraction * 100).toFixed(2)}%`,
              width: `${Math.max(0.5, (segment.endFraction - segment.startFraction) * 100).toFixed(2)}%`,
            }}
          >
            {segment.kind}: {segment.label}
            {segment.isError ? " (error)" : ""}
            {segment.endAt === null ? " (never finished)" : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}
