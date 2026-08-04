import { Hono } from "hono";
import { toDefinition } from "@plotroom/db";
import type { ApiEnv, ApiStores } from "./api.js";
import {
  toCommandNode,
  toEdge,
  toPlacedNode,
  toWorkstream,
} from "./mappers.js";

/**
 * What can be undone (spec §5, principle 10).
 *
 * "Deletion is recoverable for authored state — including when an agent did
 * the deleting" is only true if there is a way to find what was deleted. The
 * restore verbs live on the entities themselves (`POST /api/edges/:id/restore`
 * and friends), because undoing is the same gesture wherever it is offered;
 * this endpoint is the list those verbs act on, so undo works after a reload,
 * from a different surface, or on something a session removed while nobody
 * was watching.
 */
export function restorableRoutes(stores: ApiStores): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const { objects, graph, workstreams, commands, sessions } = stores;

  app.get("/restorable", (c) =>
    c.json({
      objects: objects.deleted().map((row) => ({
        id: row.id,
        title: row.title,
        deletedAt: row.deletedAt,
      })),
      // What the node verb will take back, not every deleted node: a node whose
      // subject is deleted comes back with the subject's own entry below, and
      // offering it here as well would advertise an undo that answers 409
      // (principle 10, principle 12).
      nodes: graph.restorableNodes().map((row) => toPlacedNode(row)),
      edges: graph.deletedEdges().map((row) => toEdge(row)),
      workstreams: workstreams.deleted().map((row) => toWorkstream(row)),
      commands: commands.deletedCommands().map((row) => toCommandNode(row)),
      commandDefinitions: commands
        .deletedDefinitions()
        .map((row) => toDefinition(row)),
      // A deleted session record is restorable like anything else authored
      // (§3.6, principle 10) — and the end state travels with it, so the list
      // says what would come back rather than only that something would.
      sessions: sessions.deleted().map((stored) => ({
        id: stored.session.id,
        workstreamId: stored.session.workstreamId,
        deletedAt: stored.session.deletion.deletedAt,
        end: stored.session.end,
      })),
    }),
  );

  return app;
}
