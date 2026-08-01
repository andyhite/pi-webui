import { Hono } from "hono";
import { z } from "zod";
import type { ClaimId, ClaimWaitId, SessionId } from "@plotroom/core";
import type { ClaimService } from "../claims/service.js";
import { badRequest } from "../http/errors.js";
import { validateJsonBody } from "../http/validate.js";
import { actorOf, body, param, type ApiEnv } from "./api.js";

/**
 * Path claims as endpoints (§3.4, principle 8).
 *
 * Every one of these is a tool in `@plotroom/core`'s catalog, declared there
 * before it existed here and marked `pending` until this file appeared — the
 * catalog test is what flips it, in both directions. Nothing below decides
 * anything: the claim manager decides, and a route reports what it said, so an
 * agent's `claim_request` and the claims panel reach identical verdicts.
 *
 * The operator-only verbs (`grant`, `force-release`) are enforced by the actor
 * rather than by the catalog's `humanOnly` flag alone: a flag describes, and this
 * is the gate.
 */
const requestBody = z.object({
  /**
   * A session requests for itself. There is deliberately no way to name another
   * session here — the actor header is who is asking, and a session has no way
   * to say it is someone else (`bridge.ts` refuses an actor-shaped input).
   */
  path: z.string().min(1),
  leaseSeconds: z.number().int().positive().optional(),
});

const grantBody = z.object({
  path: z.string().min(1),
  to: z.string().min(1),
  leaseSeconds: z.number().int().positive().optional(),
});

const policyBody = z.object({
  subtree: z.string().min(1),
  effect: z.enum(["allow", "deny"]),
  /** Glob relative to the subtree; `**` (the default) is the whole subtree. */
  pattern: z.string().min(1).optional(),
});

const answerBody = z.object({
  decision: z.enum(["grant", "deny"]),
});

const forceReleaseBody = z.object({
  /**
   * False by default: sub-claims are reattached to the released claim's own
   * grantor, because "a wedged intermediary should not punish its children"
   * (§3.4). Cascade is the operator saying otherwise, explicitly.
   */
  cascade: z.boolean().default(false),
});

export function claimRoutes(claims: ClaimService): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  /**
   * Request a write claim. Answers with granted, already-held, waitlisted (with
   * position), or an approval raised against the holder — never a boolean: which
   * of the two gates is closed is exactly what the caller needs to know.
   */
  app.post("/workstreams/:id/claims", validateJsonBody(requestBody), (c) => {
    const actor = actorOf(c);
    if (actor.kind !== "session") {
      // The operator holds everything implicitly (§3.4) and never waits, so
      // there is nothing for a human to request. Granting is the human verb.
      throw badRequest(
        "a claim is requested by a session; the operator holds everything implicitly and grants instead (§3.4)",
      );
    }

    const input = body<z.infer<typeof requestBody>>(c);
    const result = claims.request({
      workstreamId: param(c, "id"),
      sessionId: actor.sessionId,
      path: input.path,
      ...(input.leaseSeconds === undefined
        ? {}
        : { leaseSeconds: input.leaseSeconds }),
    });

    return c.json({ result }, result.kind === "granted" ? 201 : 200);
  });

  /**
   * Inspect: what you hold, what you wait for and where in the queue, what
   * others hold, and the policies in force. A read, and the sweep it does first
   * is not a side effect anyone can observe as one — a lapsed lease authorizes
   * nothing whether or not it has been swept (§3.4).
   */
  app.get("/workstreams/:id/claims", (c) => {
    const actor = actorOf(c);
    const inspection = claims.inspect(
      param(c, "id"),
      actor.kind === "session" ? actor.sessionId : undefined,
    );

    return c.json({
      inspection,
      // §7.2's data: position, since-when, blocked-on-human vs blocked-on-session,
      // and overlapping waitlisted paths. The alerts are Phase 6's; the facts are
      // readable now.
      metrics: claims.waitMetrics(param(c, "id")),
    });
  });

  /** The operator's direct grant (§3.4). Refused for a session by the actor. */
  app.post(
    "/workstreams/:id/claim-grants",
    validateJsonBody(grantBody),
    (c) => {
      const input = body<z.infer<typeof grantBody>>(c);
      const result = claims.grant(param(c, "id"), {
        path: input.path,
        to: input.to as SessionId,
        by: actorOf(c),
        ...(input.leaseSeconds === undefined
          ? {}
          : { leaseSeconds: input.leaseSeconds }),
      });

      return c.json({ result }, 201);
    },
  );

  /** Yield a claim you hold — an optimization; ending releases it anyway. */
  app.delete("/claims/:id", (c) =>
    c.json({ released: claims.yieldClaim(param(c, "id"), actorOf(c)) }),
  );

  /**
   * Force-release: "the escape hatch when a holder is wedged and its grantor is
   * too". The operator's alone, and the operator is never a node in the wait-for
   * graph, so this is always available (§3.4).
   */
  app.post(
    "/claims/:id/force-release",
    validateJsonBody(forceReleaseBody),
    (c) => {
      const input = body<z.infer<typeof forceReleaseBody>>(c);
      return c.json({
        released: claims.forceRelease({
          claimId: param(c, "id") as ClaimId,
          by: actorOf(c),
          cascade: input.cascade,
        }),
      });
    },
  );

  /**
   * Declare a pre-granted policy inside a claim you hold. "Without this, a
   * twenty-file change costs twenty paid round trips to a parent that must be
   * awake; correct and unusable" (§3.4). Deny wins at any depth — the policy
   * module's rule, not this route's.
   */
  app.post("/claims/:id/policies", validateJsonBody(policyBody), (c) => {
    const input = body<z.infer<typeof policyBody>>(c);
    const declared = claims.declarePolicy({
      claimId: param(c, "id") as ClaimId,
      subtree: input.subtree,
      effect: input.effect,
      by: actorOf(c),
      ...(input.pattern === undefined ? {} : { pattern: input.pattern }),
    });

    return c.json({ policy: declared.policy }, 201);
  });

  app.delete("/claim-policies/:id", (c) =>
    c.json({ withdrawn: claims.withdrawPolicy(param(c, "id"), actorOf(c)) }),
  );

  /**
   * Answer a claim approval you are the grantor of. Reflexivity-exempt on
   * purpose (§3.4's stated exemption): a parent answering its child's request is
   * redistributing reach it already holds, never creating any.
   */
  app.post("/claim-waits/:id/answer", validateJsonBody(answerBody), (c) => {
    const input = body<z.infer<typeof answerBody>>(c);
    return c.json({
      result: claims.answerApproval({
        waitId: param(c, "id") as ClaimWaitId,
        by: actorOf(c),
        decision: input.decision,
      }),
    });
  });

  /** Withdraw your own wait — "never mind, I do not need that path". */
  app.delete("/claim-waits/:id", (c) =>
    c.json({ withdrawn: claims.withdrawWait(param(c, "id"), actorOf(c)) }),
  );

  return app;
}
