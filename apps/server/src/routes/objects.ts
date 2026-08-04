import { Hono } from "hono";
import { z } from "zod";
import {
  OBJECT_KINDS,
  type Author,
  type ObjectVersion,
  type PlotObject,
} from "@plotroom/core";
import { destroyObject } from "../approvals/destruction.js";
import { atomically } from "../events/atomic.js";
import { notFound } from "../http/errors.js";
import { validateJsonBody } from "../http/validate.js";
import {
  actorOf,
  body,
  destructionGate,
  param,
  type ApiEnv,
  type ApiStores,
} from "./api.js";
import { announceRestoration } from "./announce.js";
import { toPlotObject } from "./mappers.js";

const renderings = z.object({
  card: z.record(z.string(), z.unknown()),
  summary: z.string(),
  agentContent: z.string(),
});

const delta = z.object({ summary: z.string(), body: z.string() });

const writeBody = z.object({
  kind: z.enum(OBJECT_KINDS),
  title: z.string().min(1),
  renderings,
  external: z.object({ system: z.string(), id: z.string() }).optional(),
  workstreamId: z.string().min(1).optional(),
  delta: delta.nullable().optional(),
});

const editBody = z.object({
  title: z.string().min(1).optional(),
  renderings,
  delta: delta.nullable().optional(),
});

const noteBody = z.object({
  title: z.string().min(1),
  body: z.string(),
  workstreamId: z.string().min(1).optional(),
});

const noteEditBody = z.object({
  title: z.string().min(1).optional(),
  body: z.string(),
});

/**
 * Objects, their versions, and notes (spec §3.1, §3.2, §3.8).
 *
 * Writing is create-or-reconcile: an object carrying external identity is
 * matched on it, so a re-read updates rather than duplicates, and content
 * identical to the latest version writes no version. Editing names the object
 * instead, which is what app-authored content needs — "a note you cannot edit
 * is not a note", and each edit is a new version that drifts consumers like
 * any other change.
 */
export function objectRoutes(stores: ApiStores): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const { objects, graph, bus } = stores;

  /**
   * Every write publishes what changed: the object, and the version when the
   * write made one. Returns the object so a route reads it once.
   */
  function announce(
    author: Author,
    objectId: string,
    verb: "created" | "updated",
    newVersionId?: string,
  ): PlotObject {
    const object = readObject(objectId);

    bus.publish({ entity: "object", verb, object, author });

    if (newVersionId !== undefined) {
      const version = objects
        .versions(objectId)
        .find((candidate: ObjectVersion) => candidate.id === newVersionId);
      if (version) {
        bus.publish({ entity: "version", verb: "created", version, author });
      }
    }

    return object;
  }

  /** The version id when the write made one; nothing when it did not. */
  function madeVersion(result: {
    created: boolean;
    versionId: string;
  }): string | undefined {
    return result.created ? result.versionId : undefined;
  }

  app.post("/objects", validateJsonBody(writeBody), (c) => {
    const input = body<z.infer<typeof writeBody>>(c);
    const result = objects.write({
      kind: input.kind,
      title: input.title,
      renderings: input.renderings,
      ...(input.external ? { external: input.external } : {}),
      ...(input.workstreamId ? { workstreamId: input.workstreamId } : {}),
      ...(input.delta !== undefined ? { delta: input.delta } : {}),
    });

    const object = announce(
      actorOf(c),
      result.objectId,
      "created",
      madeVersion(result),
    );

    return c.json({ object, ...result }, 201);
  });

  app.patch("/objects/:id", validateJsonBody(editBody), (c) => {
    const input = body<z.infer<typeof editBody>>(c);
    const result = objects.edit(param(c, "id"), {
      renderings: input.renderings,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.delta !== undefined ? { delta: input.delta } : {}),
    });

    const object = announce(
      actorOf(c),
      result.objectId,
      "updated",
      madeVersion(result),
    );

    return c.json({ object, ...result });
  });

  app.get("/objects/:id", (c) => {
    const id = param(c, "id");
    return c.json({
      object: readObject(id),
      content: objects.read(id),
    });
  });

  app.get("/objects/:id/versions", (c) =>
    c.json({ versions: objects.versions(param(c, "id")) }),
  );

  /**
   * Promote (§3.2): locality is a default, not a definition, so any local
   * object lifts to world scope in one gesture. Distinct from publish, which
   * marks a command's placeholder before a run (§3.5).
   */
  app.post("/objects/:id/promote", (c) => {
    const id = param(c, "id");
    objects.promote(id);
    return c.json({ object: announce(actorOf(c), id, "updated") });
  });

  /**
   * Delete an object (§3.2, principle 10) — the operator's own gesture; a
   * session's reaches this route only once §6.6 has answered
   * (`destructionGuard`), and lands on the same effect either way. The effect
   * is one transaction over the object and the node the board draws for it, and
   * it asks `checkDeletion` before it writes: the route states what the guard
   * decided rather than deciding again.
   */
  app.delete("/objects/:id", (c) => {
    const id = param(c, "id");
    // An id that names nothing is a 404 before anything else happens, which is
    // what it was when this route did the deleting itself.
    readObject(id);
    destroyObject(stores, bus, id, destructionGate(c));

    // Read back rather than returned by the effect: a soft delete leaves the row
    // exactly where it was, and the response says which one went.
    return c.json({ object: readObject(id), restorable: true });
  });

  /**
   * Undo one (principle 10): the object, its node, and the wires it had — in one
   * transaction, because a restore that half-landed is the same desync its
   * removal would have been.
   */
  app.post("/objects/:id/restore", (c) => {
    const id = param(c, "id");
    const author = actorOf(c);

    const row = atomically(stores.db, bus, (announce) => {
      const wasDeleted = objects.get(id)?.deletedAt !== null;
      const restored = objects.restore(id);

      if (wasDeleted) {
        announce.publish({
          entity: "object",
          verb: "created",
          object: toPlotObject(restored),
          author,
        });
      }

      // Roots before leaves: the object exists again before anything that
      // refers to it does — which is also what lets the node's own restore
      // check that its subject is back (`GraphStore.restoreNode`).
      const node = graph.findNodeFor("content", id);
      if (node) {
        announceRestoration(announce, author, graph.restoreNode(node.id));
      }

      return restored;
    });

    return c.json({ object: toPlotObject(row) });
  });

  /**
   * Notes (§3.8): human-authored content created directly in the app, the
   * fastest path from a thought to something on the graph. A note is an
   * object of kind `note` — the core defines concepts and nothing adds one
   * (§3.1) — so these two verbs are the gesture, not a second model.
   */
  app.post("/notes", validateJsonBody(noteBody), (c) => {
    const input = body<z.infer<typeof noteBody>>(c);
    const result = objects.write({
      kind: "note",
      title: input.title,
      renderings: noteRenderings(input.title, input.body),
      ...(input.workstreamId ? { workstreamId: input.workstreamId } : {}),
    });

    const object = announce(
      actorOf(c),
      result.objectId,
      "created",
      madeVersion(result),
    );

    return c.json({ object, ...result }, 201);
  });

  app.patch("/notes/:id", validateJsonBody(noteEditBody), (c) => {
    const id = param(c, "id");
    const input = body<z.infer<typeof noteEditBody>>(c);
    const current = objects.get(id);
    if (!current) throw notFound(`unknown object ${id}`);

    const title = input.title ?? current.title;
    const result = objects.edit(id, {
      title,
      renderings: noteRenderings(title, input.body),
    });

    const object = announce(
      actorOf(c),
      result.objectId,
      "updated",
      madeVersion(result),
    );

    return c.json({ object, ...result });
  });

  function readObject(id: string) {
    const row = objects.get(id);
    if (!row) throw notFound(`unknown object ${id}`);
    return toPlotObject(row);
  }

  return app;
}

/**
 * A note's three renderings (§3.2), supplied here because the app is what
 * produced it. The summary is the title rather than a cut-down body: the
 * product never silently truncates (principle 12), and a compact rendering
 * that lied about length would be exactly that.
 */
function noteRenderings(title: string, text: string) {
  return { card: { title }, summary: title, agentContent: text };
}
