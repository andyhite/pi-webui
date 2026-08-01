import { Hono } from "hono";
import type { ApiEnv, ApiStores } from "./api.js";
import {
  toCommandNode,
  toEdge,
  toPlacedNode,
  toPlotObject,
  toWorkstream,
} from "./mappers.js";

/**
 * The board snapshot (Epic 2.2's deferred item, landed here): one read that
 * returns everything the canvas renders as a single consistent picture,
 * rather than the per-entity reads the rest of this file assembles it from
 * one call at a time. Every row travels in the same shape `mappers.ts`
 * already gives the per-entity GETs and the WS event stream (principle 8) —
 * there is no snapshot-only vocabulary to keep in sync with the real one.
 *
 * Resync pattern for `/ws` (documented here rather than built as replay,
 * since the WS route already says a REST snapshot plus its sequence number
 * is how this was always meant to work — see `ws/route.ts`'s `hello`):
 *
 *   1. Connect to `/ws` first and buffer every event it sends, unapplied.
 *   2. Fetch this snapshot. It carries `seq`: the sequence number of the
 *      most recent event already reflected in the rows below (0 if none has
 *      published yet).
 *   3. Render from the snapshot, then drain the buffer: drop any event with
 *      `event.seq <= snapshot.seq` (already reflected), and apply the rest,
 *      in order.
 *
 * Connecting first is what makes this safe without server-side replay: a
 * client that fetched the snapshot first and then connected could miss an
 * event published in between. Applying events is idempotent by
 * construction — "created"/"updated" carry the full entity (never a diff),
 * so re-applying one already reflected in the snapshot is a no-op overwrite,
 * not a double-apply.
 */
export function snapshotRoutes(stores: ApiStores): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const { db, bus, objects, graph, workstreams, commands, sessions } = stores;

  app.get("/snapshot", (c) => {
    // Captured before the read and never touched again: nothing else can
    // run between this line and the transaction below (Node is
    // single-threaded and every store call here is synchronous), so it is
    // exactly the sequence number of the newest event the rows can possibly
    // already reflect.
    const seq = bus.nextSeq - 1;

    const snapshot = db.db.transaction(() => ({
      seq,
      // (fields continue below; the whole object is the transaction's return
      // value, read back out once as `snapshot`.)
      workstreams: workstreams
        .list({ includeArchived: true })
        .map((row) => toWorkstream(row)),
      nodes: graph.liveNodes().map((row) => toPlacedNode(row)),
      edges: graph.liveEdges().map((row) => toEdge(row)),
      objects: objects.live().map((row) => toPlotObject(row)),
      // `definitions()` and `allOutputs()` already return the domain shapes
      // (they map rows the same way `mappers.ts` does for everything else
      // here); nothing snapshot-only to build for either.
      commandDefinitions: commands.definitions(),
      commands: commands.liveCommands().map((row) => toCommandNode(row)),
      outputs: commands.allOutputs(),
      // Sessions travel with the phase PlotRoom derived, the same shape the
      // `session` event carries, so a resync lands on the same picture the
      // stream would have produced. Runs are deliberately absent: history is
      // per command and unbounded, so it is read at
      // `GET /api/commands/:id/runs` rather than shipped with every snapshot.
      sessions: sessions.list().map((stored) => ({
        session: stored.session,
        runId: stored.runId,
        phase: stored.phase,
      })),
    }));

    return c.json(snapshot);
  });

  return app;
}
