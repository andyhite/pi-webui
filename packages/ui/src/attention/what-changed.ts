/**
 * "What changed while I was away" (§7.3): "each workstream keeps a short,
 * capped history of notable events — a pull request got comments, a ticket
 * moved, work completed, a session failed — so returning tells you what
 * *happened*, not just what is currently true. Each entry routes to what it
 * was about and tolerates that target being gone."
 *
 * Shape aligned with `@plotroom/core`'s `BroadcastActivityEntry`
 * (`sessions/broadcast.ts`) rather than inventing a second one: a session
 * broadcast is one of the event kinds this history carries (§6.5: "a
 * session-originated broadcast appears ... in each recipient workstream's
 * activity history"), so `kind: "broadcast"` below is deliberately the
 * generalization of that exact row, not a parallel shape beside it.
 */

export const WORKSTREAM_ACTIVITY_KINDS = [
  "broadcast",
  "ticket-updated",
  "pull-request-updated",
  "completion",
  "failure",
] as const;

export type WorkstreamActivityKind = (typeof WORKSTREAM_ACTIVITY_KINDS)[number];

export interface WorkstreamActivityEntry {
  readonly id: string;
  readonly workstreamId: string;
  readonly kind: WorkstreamActivityKind;
  readonly text: string;
  readonly at: number;
  /** What this entry was about — routes there via selection-as-route (§5). */
  readonly targetNodeId: string;
}

/**
 * Appends one entry, then trims each workstream's own history back to
 * `cap` — "short, capped ... per workstream" (§7.3), so one noisy
 * workstream cannot crowd another's history out of a shared list. Newest
 * kept, oldest dropped, per workstream.
 */
export function appendActivityEntry(
  history: readonly WorkstreamActivityEntry[],
  entry: WorkstreamActivityEntry,
  cap: number,
): readonly WorkstreamActivityEntry[] {
  const withNew = [...history, entry];
  const byWorkstream = new Map<string, WorkstreamActivityEntry[]>();
  for (const item of withNew) {
    const list = byWorkstream.get(item.workstreamId) ?? [];
    list.push(item);
    byWorkstream.set(item.workstreamId, list);
  }

  const trimmed: WorkstreamActivityEntry[] = [];
  for (const list of byWorkstream.values()) {
    trimmed.push(...list.slice(Math.max(0, list.length - cap)));
  }
  // Stable overall ordering: oldest to newest, matching input order rather
  // than the per-workstream grouping order above.
  const order = new Map(withNew.map((item, index) => [item.id, index]));
  return trimmed.sort(
    (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
  );
}

export function activityForWorkstream(
  history: readonly WorkstreamActivityEntry[],
  workstreamId: string,
): readonly WorkstreamActivityEntry[] {
  return history.filter((entry) => entry.workstreamId === workstreamId);
}

/**
 * Whether selecting this entry can actually navigate anywhere (§7.3
 * "tolerates that target being gone"). The graph is the source of truth for
 * "does this node still exist" — this takes a lookup rather than the whole
 * snapshot so it stays a one-line pure predicate to test.
 */
export function activityTargetExists(
  entry: WorkstreamActivityEntry,
  nodeExists: (nodeId: string) => boolean,
): boolean {
  return nodeExists(entry.targetNodeId);
}

/**
 * The honest row when the target is gone: never a silent failure to
 * navigate, never removing the entry (the event still happened) — a
 * tombstone that says so in the entry's own words.
 */
export function describeActivityTarget(
  entry: WorkstreamActivityEntry,
  nodeExists: (nodeId: string) => boolean,
): string {
  return activityTargetExists(entry, nodeExists)
    ? entry.targetNodeId
    : `${entry.targetNodeId} (no longer on the graph)`;
}
