import { Hono } from "hono";
import { z } from "zod";
import type { Author } from "@plotroom/core";
import { forbidden } from "../http/errors.js";
import { validateJsonBody } from "../http/validate.js";
import type { SettingsService } from "../settings/service.js";
import { actorOf, body, param, type ApiEnv } from "./api.js";

const setBody = z.object({ value: z.unknown() });

/**
 * Settings (§11, §8, Epic 8.3): "grouped, searchable, applied without
 * restart; environment variables only supply defaults."
 *
 * `GET /settings` is the grouped, searchable read `q` filters over (label,
 * description, group, key) — the shape a Settings surface needs to render
 * without a second endpoint per group. Every write names, in its own answer,
 * whether it took effect without a restart and, when it did not, why —
 * `SettingsService` states this from the catalog, never re-derived here.
 *
 * Every verb is gated by the catalog's own `humanOnly` flag, enforced by
 * actor here — the same arrangement `log-level.ts` keeps for **both** of its
 * verbs, not only the write: this batch's settings are infrastructure-shaped
 * (bind address, credential, concurrency, runtime, workspace defaults) and
 * every entry in the catalog is `humanOnly` today, deliberately conservative
 * under principle 1 rather than deciding a nuanced read/write split under
 * this batch's time. A bulk list filters a session actor down to whatever
 * entries are not `humanOnly` (none, today) rather than refusing the read
 * outright — the same "show what applies to you" shape other list endpoints
 * use — while a single-key read of a `humanOnly` setting refuses exactly
 * like a write would, so a session cannot learn anything a list would not
 * have shown it either.
 */
export function settingsRoutes(settings: SettingsService): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get("/settings", (c) => {
    const q = c.req.query("q");
    const all = q ? settings.search(q) : settings.list();
    const actor = actorOf(c);
    return c.json({
      settings: actor.kind === "human" ? all : all.filter((s) => !s.humanOnly),
    });
  });

  app.get("/settings/:key", (c) => {
    const key = param(c, "key");
    requireOperatorFor(settings, key, actorOf(c), "reading a setting");
    return c.json({ setting: settings.get(key) });
  });

  app.put("/settings/:key", validateJsonBody(setBody), (c) => {
    const key = param(c, "key");
    requireOperatorFor(settings, key, actorOf(c), "writing a setting");
    const { value } = body<z.infer<typeof setBody>>(c);
    return c.json({ setting: settings.set(key, value, actorOf(c)) });
  });

  app.delete("/settings/:key", (c) => {
    const key = param(c, "key");
    requireOperatorFor(settings, key, actorOf(c), "reverting a setting");
    return c.json({ setting: settings.remove(key, actorOf(c)) });
  });

  return app;
}

function requireOperatorFor(
  settings: SettingsService,
  key: string,
  actor: Author,
  gesture: string,
): void {
  const current = settings.get(key); // 404s on an unknown key before the actor check
  if (!current.humanOnly || actor.kind === "human") return;
  throw forbidden(
    `${gesture} ("${key}") is the operator's control (§11, principle 1); a session cannot make it`,
  );
}
