import type { Context, MiddlewareHandler, Next } from "hono";
import {
  humanAuthor,
  sessionAuthor,
  type Author,
  type SessionId,
} from "@plotroom/core";
import { badRequest } from "./errors.js";

/**
 * Who is making this call (Epic 2.2, §15 invariant 2).
 *
 * One mechanism, applied uniformly: a request declares its actor in the
 * `X-PlotRoom-Actor` header, as `human` or `session:<sessionId>`. It is a
 * header rather than a body field because attribution is a property of the
 * *caller*, not of the thing being written — putting it in the body would
 * mean every schema restates it and every GET-shaped verb has nowhere to put
 * it. It is explicit rather than derived from the credential because the
 * credential identifies the installation (§12), not the actor: the operator
 * and every session it runs share one.
 *
 * The human operator is the default: an omitted header means the person at
 * the keyboard, which is what a hand-written `curl` and the renderer both
 * are. What is never allowed is an *unparseable* actor — an unattributed
 * write has no representation here any more than it does in the schema.
 */
export const ACTOR_HEADER = "x-plotroom-actor";

export type ActorResult =
  | { readonly ok: true; readonly actor: Author }
  | { readonly ok: false; readonly reason: string };

/** Pure, so the rule is testable without a server (and reusable by the WS). */
export function parseActor(header: string | undefined): ActorResult {
  const raw = header?.trim();
  if (!raw || raw === "human") return { ok: true, actor: humanAuthor };

  const [kind, ...rest] = raw.split(":");
  const sessionId = rest.join(":").trim();

  if (kind !== "session" || sessionId.length === 0) {
    return {
      ok: false,
      reason: `actor must be "human" or "session:<sessionId>", got ${JSON.stringify(raw)}`,
    };
  }

  return { ok: true, actor: sessionAuthor(sessionId as SessionId) };
}

export function actorMiddleware(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const result = parseActor(c.req.header(ACTOR_HEADER));
    if (!result.ok) throw badRequest(result.reason);

    c.set("actor", result.actor);
    await next();
  };
}
