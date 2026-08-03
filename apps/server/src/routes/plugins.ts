import { Hono } from "hono";
import { z } from "zod";
import { validateJsonBody } from "../http/validate.js";
import type { PluginService } from "../plugins/service.js";
import { actorOf, body, param, type ApiEnv } from "./api.js";

/**
 * The plugin platform's endpoints (§10.2, `docs/plugin-contract.md` §8).
 *
 * **Every one of them is operator-only, and there is no agent tool for any of
 * them** — principle 1: a session cannot install a plugin or grant it a permission,
 * for the same reason it cannot raise the budget that binds it. The enforcement is
 * the request's actor inside `PluginService`, not this file's route list, so an
 * internal caller cannot route around it.
 *
 * Two shapes worth stating:
 *
 * - **`GET /api/plugins` is the §10.2 health surface**, whole: `loading` / `ready`
 *   (with warnings) / `restarting` / `unavailable` (with the reason) / `disposed` /
 *   `disabled`, each plugin's declared permissions with the operator's answer, its
 *   contributions, and the connection state of every integration connected to one of
 *   its producers. Plus `failures`: what could not be installed at all, which has no
 *   status because it has no readable manifest (principle 12).
 * - **An install failure is a 200 with the reason, not a 500.** A plugin that cannot
 *   be read is a fact about that plugin; the server is fine, and answering 500 would
 *   report the product as broken.
 */
const installBody = z.object({
  /** A module specifier or `file:` URL the host imports in a worker. */
  entry: z.string().min(1),
});

const grantBody = z.object({
  permissionId: z.string().min(1),
  /** `null` removes the answer: the permission is never-asked again (§10.2). */
  state: z.union([z.literal("granted"), z.literal("denied"), z.null()]),
});

export function pluginRoutes(plugins: PluginService): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get("/plugins", (c) =>
    c.json({ plugins: plugins.list(), failures: plugins.failures() }),
  );

  app.get("/plugins/:id", (c) =>
    c.json({ plugin: plugins.get(param(c, "id")) }),
  );

  app.post("/plugins/install", validateJsonBody(installBody), async (c) => {
    const input = body<z.infer<typeof installBody>>(c);
    const result = await plugins.install(input.entry, actorOf(c));
    // This call's own failure, carried back by the call: reading the most recent
    // entry from the failure list would show whoever's reason arrived last.
    return result.installed
      ? c.json({ installed: true, plugin: result.plugin }, 201)
      : c.json({ installed: false, failure: result.failure }, 200);
  });

  /** Re-scan the configured plugins directory — the operator's gesture, never a
   * timer (§10.2, principle 2). */
  app.post("/plugins/scan", async (c) => {
    const installed = await plugins.scanDirectory(actorOf(c));
    return c.json({ installed, failures: plugins.failures() });
  });

  app.post("/plugins/:id/enable", async (c) => {
    const plugin = await plugins.enable(param(c, "id"), actorOf(c));
    return c.json({ plugin });
  });

  app.post("/plugins/:id/disable", async (c) => {
    const plugin = await plugins.disable(param(c, "id"), actorOf(c));
    return c.json({ plugin });
  });

  /** Forget it. Deletes nothing on disk — the directory is the operator's. */
  app.delete("/plugins/:id", async (c) => {
    await plugins.remove(param(c, "id"), actorOf(c));
    return c.json({ removed: true });
  });

  app.post("/plugins/:id/grants", validateJsonBody(grantBody), (c) => {
    const input = body<z.infer<typeof grantBody>>(c);
    const plugin = plugins.answerGrant(
      param(c, "id"),
      input.permissionId,
      input.state,
      actorOf(c),
    );
    return c.json({ plugin });
  });

  return app;
}
