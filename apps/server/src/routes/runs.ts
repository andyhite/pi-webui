import { Hono } from "hono";
import { z } from "zod";
import { validateJsonBody } from "../http/validate.js";
import type { RunQueueService } from "../runs/queue.js";
import type { RunService } from "../runs/service.js";
import { runtimeScriptSchema } from "../runtime/scripted.js";
import { actorOf, body, param, type ApiEnv, type ApiStores } from "./api.js";

/**
 * Runs and the §4.1 gesture, as endpoints.
 *
 * Every one of these is the same vocabulary an agent tool will call (Epic 4.5,
 * principle 8): running a command, submitting an outcome, stopping a session.
 * The rules are not restated here — the service calls the predicates and the
 * stores, and a route reports what they said.
 */
const runBody = z.object({
  commandId: z.string().min(1),
  /**
   * The client's own idea of "this gesture" (principle 9). A retry or a
   * reconnect that sends the same key gets the same run and the same session
   * back, never a second one.
   */
  initiationKey: z.string().min(1),
  runtime: z
    .object({
      adapterId: z.string().min(1).optional(),
      /** Only the scripted runtime accepts one, and only when it is selected. */
      script: runtimeScriptSchema.optional(),
    })
    .optional(),
  /**
   * The cap accepted at the preview (§4.1, §8), in integer micros. Recorded on
   * the run; enforcement is Phase 6. Null is "no cap accepted", which is not the
   * same as a cap of zero — hence nullable rather than defaulted.
   */
  spendCapMicros: z.number().int().nonnegative().nullable().optional(),
});

const submitBody = z.object({
  outputs: z
    .array(
      z.object({
        name: z.string().min(1),
        objectId: z.string().min(1),
        versionId: z.string().min(1),
      }),
    )
    .optional(),
});

export function runRoutes(
  stores: ApiStores,
  service: RunService,
  queue: RunQueueService,
): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  /**
   * The run preview (§4.1): exactly what will execute, what history says it will
   * cost, and the cap to accept — before anything starts.
   *
   * A GET, because it is a read: it provisions nothing, starts nothing, and
   * records nothing. Everything that would refuse the run is reported here
   * instead, so this is also the endpoint that answers "why can't I run this".
   */
  app.get("/commands/:id/preview", (c) =>
    c.json(service.preview(param(c, "id"))),
  );

  /**
   * Run one command (§4.1): idempotent in the initiation key, and **bounded by
   * the concurrency limit** like every other initiation.
   *
   * The limit "bounds how many sessions run at once", which is a property of
   * initiation rather than of one endpoint — so this gesture goes through the same
   * admission the scoped ones do instead of being a second door that ignores it.
   * That makes the response two-shaped, deliberately:
   *
   * - **201** (or 200 for a replayed key) with `{ run, session, status }` — a slot
   *   was free and the session is running, exactly as before;
   * - **202** with `{ queued, run: null, session: null }` — the gesture was
   *   admitted and is waiting, with its position, cancellable before it starts
   *   (§4.1). It is not a refusal: the system is deciding *when*, never *whether*.
   *
   * A caller that reads `session.id` unconditionally fails loudly on a 202 rather
   * than quietly proceeding with a session that does not exist yet, which is the
   * behaviour to want here.
   */
  app.post("/runs", validateJsonBody(runBody), async (c) => {
    const input = body<z.infer<typeof runBody>>(c);
    const admission = await queue.runOne({
      commandId: input.commandId,
      initiationKey: input.initiationKey,
      actor: actorOf(c),
      ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
      ...(input.spendCapMicros === undefined
        ? {}
        : { spendCapMicros: input.spendCapMicros }),
    });

    if (!admission.admitted) {
      return c.json(
        {
          run: null,
          session: null,
          status: null,
          warning: null,
          replayed: false,
          queued: admission.queued,
        },
        202,
      );
    }

    const result = admission.result;
    return c.json(
      {
        run: result.run,
        session: result.session.session,
        status: result.status,
        // Assembly warns as it approaches the model's window; it never
        // truncates, and the warning travels with the run that carries it.
        warning: result.warning,
        replayed: result.replayed,
        queued: null,
      },
      result.replayed ? 200 : 201,
    );
  });

  /**
   * §15-1: the exact assembled content and the configuration it ran under, plus
   * the versions that went in. `assembled` is the bytes the agent was given,
   * byte for byte, however the objects behind them have changed since.
   */
  app.get("/runs/:id", (c) => {
    const id = param(c, "id");
    const run = stores.runs.run(id);

    return c.json({
      run,
      configuration: run.configuration,
      inputs: run.inputs,
      proof: stores.runs.proof(id),
      submissions: stores.runs.submissions(id),
    });
  });

  app.get("/runs/:id/assembled", (c) => {
    const id = param(c, "id");
    return c.json({
      runId: id,
      hash: stores.runs.run(id).assembledHash,
      content: stores.runs.assembledContent(id),
    });
  });

  /** §15-4: run history, oldest first; the ordinal is the n in `output@n`. */
  app.get("/commands/:id/runs", (c) =>
    c.json({ runs: stores.runs.history(param(c, "id")) }),
  );

  /**
   * The completion loop (§3.5): the session says it is done, PlotRoom checks the
   * declared world conditions itself. A failing condition comes back as feedback
   * and the session continues; only proof ends it as completed.
   */
  app.post("/sessions/:id/submit", validateJsonBody(submitBody), async (c) => {
    const input = body<z.infer<typeof submitBody>>(c);
    const result = await service.submit({
      sessionId: param(c, "id"),
      actor: actorOf(c),
      ...(input.outputs === undefined ? {} : { outputs: input.outputs }),
    });

    // Not a refusal: a failed submission is an answer the session acts on, and
    // it is the same answer whether a human or a runtime asked.
    return c.json(result);
  });

  return app;
}
