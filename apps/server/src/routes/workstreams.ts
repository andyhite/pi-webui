import { Hono } from "hono";
import { z } from "zod";
import { WORKSTREAM_STATUSES } from "@plotroom/core";
import { validateJsonBody } from "../http/validate.js";
import { notFound } from "../http/errors.js";
import { destroyWorkstream } from "../approvals/destruction.js";
import {
  actorOf,
  body,
  destructionGate,
  param,
  type ApiEnv,
  type ApiStores,
} from "./api.js";
import { toWorkstream } from "./mappers.js";

const createBody = z.object({ subjectId: z.string().min(1).optional() });

const patchBody = z
  .object({
    subjectId: z.string().min(1).optional(),
    status: z.enum(WORKSTREAM_STATUSES).optional(),
  })
  .refine(
    (value) => value.subjectId !== undefined || value.status !== undefined,
    { message: "patch must set a subject, a status, or both" },
  );

/**
 * Workstreams (spec §3.3) as endpoints: create, name the subject, set the
 * lifecycle, archive, delete, and undo each of those. Every one of them is a
 * gesture on the canvas, and every one is here, because an agent gets the
 * same vocabulary (principle 8).
 *
 * Lifecycle is human-only — the store calls `checkLifecycleAuthoring`, and a
 * session gets that predicate's refusal rather than a differently-worded one
 * invented here. Deletion is not: an agent may delete, and the answer to that
 * is recoverability (principle 10), which is what `restore` is.
 */
export function workstreamRoutes(stores: ApiStores): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const { workstreams, bus } = stores;

  /** The row, or a 404 — never `undefined` passed on to something else. */
  function read(id: string) {
    const row = workstreams.get(id);
    if (!row) throw notFound(`unknown workstream ${id}`);
    return row;
  }

  app.post("/workstreams", validateJsonBody(createBody), (c) => {
    const input = body<z.infer<typeof createBody>>(c);
    const author = actorOf(c);
    const created = workstreams.create({
      author,
      ...(input.subjectId !== undefined ? { subjectId: input.subjectId } : {}),
    });

    bus.publish({
      entity: "workstream",
      verb: "created",
      workstream: toWorkstream(created),
      author,
    });

    return c.json({ workstream: toWorkstream(created) }, 201);
  });

  app.get("/workstreams", (c) => {
    const includeArchived = c.req.query("includeArchived") === "true";
    return c.json({
      workstreams: workstreams
        .list({ includeArchived })
        .map((row) => toWorkstream(row)),
    });
  });

  app.get("/workstreams/:id", (c) => {
    const id = param(c, "id");
    const row = workstreams.get(id);
    if (!row) throw notFound(`unknown workstream ${id}`);

    return c.json({
      workstream: toWorkstream(row),
      archived: row.archivedAt !== null,
      deleted: row.deletedAt !== null,
      attention: workstreams.attention(id),
      contents: workstreams.contents(id),
      events: workstreams.events(id),
    });
  });

  app.patch("/workstreams/:id", validateJsonBody(patchBody), (c) => {
    const id = param(c, "id");
    const input = body<z.infer<typeof patchBody>>(c);
    const author = actorOf(c);

    let row = workstreams.get(id);
    if (!row) throw notFound(`unknown workstream ${id}`);

    if (input.subjectId !== undefined) {
      row = workstreams.setSubject(id, input.subjectId, author);
    }
    if (input.status !== undefined) {
      row = workstreams.setStatus(id, input.status, author);
    }

    bus.publish({
      entity: "workstream",
      verb: "updated",
      workstream: toWorkstream(row),
      author,
    });

    return c.json({ workstream: toWorkstream(row) });
  });

  for (const gesture of ["archive", "unarchive"] as const) {
    app.post(`/workstreams/:id/${gesture}`, (c) => {
      const author = actorOf(c);
      const row = workstreams[gesture](param(c, "id"), author);

      bus.publish({
        entity: "workstream",
        verb: "updated",
        workstream: toWorkstream(row),
        author,
      });

      return c.json({ workstream: toWorkstream(row) });
    });
  }

  app.delete("/workstreams/:id", (c) => {
    const id = param(c, "id");
    // An id that names nothing is a 404 before anything else happens, and the
    // row is read back afterwards: a soft delete leaves it exactly where it was.
    read(id);
    destroyWorkstream(stores, bus, id, destructionGate(c));

    return c.json({ workstream: toWorkstream(read(id)), restorable: true });
  });

  app.post("/workstreams/:id/restore", (c) => {
    const id = param(c, "id");
    const author = actorOf(c);
    const wasDeleted = workstreams.get(id)?.deletedAt !== null;
    const row = workstreams.restore(id, author);

    if (wasDeleted) {
      bus.publish({
        entity: "workstream",
        verb: "created",
        workstream: toWorkstream(row),
        author,
      });
    }

    return c.json({ workstream: toWorkstream(row) });
  });

  return app;
}
