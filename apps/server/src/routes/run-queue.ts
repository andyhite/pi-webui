import { Hono } from "hono";
import { z } from "zod";
import { RUN_SCOPE_KINDS } from "@plotroom/core";
import { badRequest } from "../http/errors.js";
import { validateJsonBody } from "../http/validate.js";
import type { RunQueueService } from "../runs/queue.js";
import { actorOf, body, param, type ApiEnv } from "./api.js";

/**
 * Scoped runs and the queue (§4.1, Epic 5.5).
 *
 * Every verb here is a gesture the operator has and therefore a tool an agent has
 * (principle 8) — including the confirmation a drifted queued run asks for, which
 * would otherwise be a decision only a human could ever make about work a session
 * initiated.
 *
 * The preview is a GET because it is a read: it resolves the scope, previews each
 * command, and records nothing. Everything that would refuse the scope is reported
 * there rather than at the moment of running, which is what makes "the run
 * affordance never disables" implementable — a blocked command has something to
 * show instead of a disabled button.
 */
const scopeBody = z.object({
  scope: z.enum(RUN_SCOPE_KINDS),
  /**
   * The command or workstream the scope is taken from; omitted only for
   * `drifted-fleet`, which is the whole board by definition.
   */
  scopeId: z.string().min(1).nullable().optional(),
  /** One key covers the whole scope, however many commands (principle 9). */
  initiationKey: z.string().min(1),
  /**
   * The cap accepted at the scoped preview (§4.1). Applied to every run in the
   * scope; Phase 6 enforces it.
   */
  spendCapMicros: z.number().int().nonnegative().nullable().optional(),
});

export function runQueueRoutes(queue: RunQueueService): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  /**
   * The scoped preview: "every scoped run previews exactly what it will execute
   * and what it may cost before it starts, and accepts a spend cap" (§4.1).
   */
  app.get("/run-scopes/preview", (c) => {
    const scope = c.req.query("scope");
    const parsed = z.enum(RUN_SCOPE_KINDS).safeParse(scope);
    if (!parsed.success) {
      throw badRequest(
        `scope must be one of ${RUN_SCOPE_KINDS.join(", ")} (got ${JSON.stringify(scope)})`,
      );
    }

    return c.json(
      queue.preview({
        scope: parsed.data,
        scopeId: c.req.query("scopeId") ?? null,
      }),
    );
  });

  /**
   * Initiate a scope. Admission, not scheduling: whatever fits under the
   * concurrency limit starts before this answers, and the rest is queued and
   * visible with its position.
   */
  app.post("/run-scopes", validateJsonBody(scopeBody), async (c) => {
    const input = body<z.infer<typeof scopeBody>>(c);
    const result = await queue.initiate({
      scope: input.scope,
      scopeId: input.scopeId ?? null,
      initiationKey: input.initiationKey,
      actor: actorOf(c),
      ...(input.spendCapMicros === undefined
        ? {}
        : { spendCapMicros: input.spendCapMicros }),
    });

    return c.json(result, result.replayed ? 200 : 201);
  });

  /** The queue itself: what is waiting, where, and what is asking to be confirmed. */
  app.get("/run-queue", (c) =>
    c.json({ queued: queue.open(), batches: queue.batches() }),
  );

  /**
   * One batch, whole: every entry including the settled ones. A paused batch's
   * failed run is exactly what "address it and resume" is about, so it must still
   * be readable after it settled.
   */
  app.get("/run-batches/:id", (c) => c.json(queue.batch(param(c, "id"))));

  /** "Cancellable before it starts" (§4.1) — and refused after. */
  app.delete("/run-queue/:id", async (c) =>
    c.json({ cancelled: await queue.cancel(param(c, "id"), actorOf(c)) }),
  );

  /**
   * Answer the re-ask (§4.1): the inputs drifted while this waited, so it did not
   * run. Confirming accepts what it would assemble *now* — the entry is never
   * quietly re-queued under a contract nobody agreed to.
   */
  app.post("/run-queue/:id/confirm", async (c) =>
    c.json({ confirmed: await queue.confirm(param(c, "id"), actorOf(c)) }),
  );

  /**
   * Resume a paused batch (§4.1): "it pauses on a failed or out-of-budget session
   * — resumable once the human addresses it". An aborted batch never resumes,
   * because stopped means stopped.
   */
  app.post("/run-batches/:id/resume", async (c) =>
    c.json({ batch: await queue.resumeBatch(param(c, "id"), actorOf(c)) }),
  );

  return app;
}
