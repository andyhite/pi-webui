import { Hono } from "hono";
import { z } from "zod";
import { approvalAttention } from "@plotroom/core";
import { notFound } from "../http/errors.js";
import { validateJsonBody } from "../http/validate.js";
import type { IntegrationService } from "../integrations/service.js";
import { actorOf, body, param, type ApiEnv } from "./api.js";

/**
 * The integration substrate's endpoints (§9.1–§9.3, Epic 7.2).
 *
 * Every one of these has a matching entry in `@plotroom/core`'s agent tool
 * catalog — `integration_connect`/`_disconnect`/`_scoping_update` are the
 * connect-flow's own gestures, declared `humanOnly` because a credential is
 * entered here (§9.3); `_refresh`, `_object_refresh`, and
 * `_write_action_perform` are session-callable, because a manual refresh and a
 * declared write are exactly the gestures §9.1/§9.2 say an agent has too.
 */
const connectBody = z.object({
  pluginId: z.string().min(1),
  producerId: z.string().min(1),
  name: z.string().min(1),
  scope: z.string().nullable().optional(),
  credentialName: z.string().min(1).optional(),
  credentialValue: z.string().min(1).optional(),
});

const scopingBody = z.object({
  scope: z.string().nullable(),
});

const writeActionBody = z.object({
  input: z.record(z.string(), z.unknown()).default({}),
  /** The caller's own name for this call; a retry finds the same approval (principle 9). */
  callId: z.string().min(1),
});

export function integrationRoutes(
  integrations: IntegrationService,
): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get("/integration-plugins", (c) =>
    c.json({
      producers: integrations.producers().map((producer) => ({
        id: producer.id,
        kinds: producer.kinds,
        refresh: producer.refresh,
        scoping: producer.scoping,
        writeActions: (producer.writeActions ?? []).map((action) => ({
          id: action.id,
          action: action.action,
          system: action.system,
          reversibility: action.reversibility,
        })),
      })),
    }),
  );

  app.post("/integrations", validateJsonBody(connectBody), (c) => {
    const input = body<z.infer<typeof connectBody>>(c);
    const integration = integrations.connect({
      pluginId: input.pluginId,
      producerId: input.producerId,
      name: input.name,
      scope: input.scope ?? null,
      ...(input.credentialName === undefined
        ? {}
        : { credentialName: input.credentialName }),
      ...(input.credentialValue === undefined
        ? {}
        : { credentialValue: input.credentialValue }),
    });
    return c.json({ integration }, 201);
  });

  app.get("/integrations", (c) =>
    c.json({ integrations: integrations.list() }),
  );

  app.get("/integrations/:id", (c) => {
    const id = param(c, "id");
    return c.json({ integration: integrations.get(id) });
  });

  app.patch("/integrations/:id", validateJsonBody(scopingBody), (c) => {
    const id = param(c, "id");
    const input = body<z.infer<typeof scopingBody>>(c);
    const integration = integrations.updateScoping(id, input.scope);
    return c.json({ integration });
  });

  app.post("/integrations/:id/disconnect", (c) => {
    const id = param(c, "id");
    const integration = integrations.disconnect(id);
    return c.json({ integration });
  });

  /** Manual refresh, always available, whole-integration (§9.1). */
  app.post("/integrations/:id/refresh", async (c) => {
    const id = param(c, "id");
    const outcome = await integrations.refresh(id);
    return c.json(outcome, outcome.ok ? 200 : 502);
  });

  /** Manual refresh, always available, per object (§9.1). */
  app.post("/integrations/:id/objects/:externalId/refresh", async (c) => {
    const id = param(c, "id");
    const externalId = param(c, "externalId");
    const outcome = await integrations.refresh(id, { externalId });
    return c.json(outcome, outcome.ok ? 200 : 502);
  });

  app.get("/integrations/:id/write-actions", (c) => {
    const id = param(c, "id");
    const integration = integrations.get(id);
    const producer = integrations
      .producers()
      .find((candidate) => candidate.id === integration.producerId);
    if (producer === undefined)
      throw notFound(`unknown producer ${integration.producerId}`);

    return c.json({
      writeActions: (producer.writeActions ?? []).map((action) => ({
        id: action.id,
        action: action.action,
        system: action.system,
        reversibility: action.reversibility,
        input: action.input,
      })),
    });
  });

  /**
   * Execute a declared write action (§9.2, §6.6): the UI action and the agent
   * tool are one endpoint, and a session's call may come back 202 asking for
   * an approval instead of having executed — the same shape the destruction
   * guard already answers with (`apps/server/src/approvals/guard.ts`).
   */
  app.post(
    "/integrations/:id/write-actions/:actionId",
    validateJsonBody(writeActionBody),
    async (c) => {
      const id = param(c, "id");
      const actionId = param(c, "actionId");
      const input = body<z.infer<typeof writeActionBody>>(c);
      const actor = actorOf(c);

      const outcome = await integrations.performWrite({
        integrationId: id,
        actionId,
        actionInput: input.input,
        actor,
        callId: input.callId,
      });

      if (outcome.kind === "must-ask") {
        return c.json(
          {
            approval: outcome.approval,
            attention: approvalAttention(outcome.approval),
            executed: false,
          },
          202,
        );
      }

      return c.json(
        {
          ok: outcome.ok,
          message: outcome.message,
          readBack: outcome.readBack,
        },
        outcome.ok ? 200 : 502,
      );
    },
  );

  return app;
}
