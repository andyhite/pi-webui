import type { MiddlewareHandler } from "hono";
import { approvalAttention, destructionTools } from "@plotroom/core";
import { forbidden } from "../http/errors.js";
import type { Logger } from "../logging/logger.js";
import { actorOf, type ApiEnv } from "../routes/api.js";
import { matchToolRoute, toolRoutes } from "./routes.js";
import type { ApprovalService } from "./service.js";

/**
 * A session's destructive gesture raises an approval instead of executing
 * (§6.6, principle 10).
 *
 * "Destructive gestures against authored state requested by an agent go through
 * this same channel." So `DELETE /api/objects/:id` from a session does not delete
 * the object: it raises an approval carrying what would be removed, answers 202,
 * and the soft delete runs when the operator approves — attributed to the session
 * that asked (`ApprovalService.answer`).
 *
 * **Which routes this covers is catalog metadata, not a list here.** The
 * destruction-class tools are the ones declaring `requires.destroys`, and the
 * endpoint each one names is the route it guards, so a new destructive verb is
 * covered the moment it declares one — the same property `decideDestruction` has
 * upstream. A guard with its own list would be the second list §6.6's routing
 * exists to avoid, and the one that would be missing an entry.
 *
 * The operator is never gated (§6.6 is about a session requesting capability),
 * and a call this cannot recognise falls through rather than being refused: a
 * refusal here for an unknown route would be this middleware deciding something
 * it was not asked about.
 *
 * **`sessionLineageGuard` runs before this one, and that ordering is the rule.**
 * §6.6 answers "may this session do it"; principle 1 answers "is this even a
 * thing a session may be granted", and the second question has to be settled
 * first — a pre-grant matches by tool and never by target, so an "allow always"
 * evaluated here would otherwise cover a delete inside the caller's own chain
 * with nobody asked (`lineage.ts`, issue #75).
 *
 * **What catches a call that gets past this.** `performDestruction` — the one
 * function that actually destroys anything on a session's behalf — asks
 * `checkDeletion` first, and that predicate refuses a session-authored deletion
 * with no approval behind it. So a future call site that forgets to route through
 * here fails closed rather than deleting. Note the honest limit: the *routes*
 * still perform their own soft deletes inline (`objects.ts`, `graph.ts`,
 * `commands.ts`, `workstreams.ts`) and do not call that predicate, so for those
 * this middleware is the enforcement and not a second line — which is why the
 * catalog test pins every destruction tool's endpoint to a shape this can match.
 */
export interface DestructionGuardDeps {
  readonly approvals: ApprovalService;
  readonly logger: Logger;
}

export function destructionGuard(
  deps: DestructionGuardDeps,
): MiddlewareHandler<ApiEnv> {
  // The routes to guard, derived once from the catalog. Every destruction tool
  // declares **exactly one** path parameter — the record it would remove — and
  // `catalog.test.ts` pins that in both directions, so `toolRoutes`' skip cannot
  // quietly become the hole through which an unguarded destructive verb ships.
  const routes = toolRoutes(
    destructionTools(),
    deps.logger,
    "§6.6 routes a session's destruction by the target its endpoint names; a tool with anything but one path parameter names no single target, so this route is not guarded",
  );

  return async (c, next) => {
    const actor = actorOf(c);
    if (actor.kind !== "session") return next();

    const matched = matchToolRoute(routes, c.req.method, c.req.path);
    if (matched === null) return next();

    const session = deps.approvals.sessionOf(actor.sessionId);
    const routing = deps.approvals.decideDestruction({
      toolName: matched.tool.name,
      targetId: matched.targetId,
      actor,
      sessionId: actor.sessionId,
      workstreamId: session?.workstreamId ?? null,
    });

    if (routing.kind === "not-destruction") return next();

    switch (routing.verdict.kind) {
      case "allowed":
        // Answered, or nothing gated it. The gesture executes as the session's
        // own, which is what the operator agreed to.
        return next();

      case "denied":
        // Feedback, not a fault: the operator's own reason travels back so the
        // session can act on it rather than retry the same call (§6.6).
        throw forbidden(routing.verdict.reason);

      case "must-ask": {
        if (session === null) {
          // Fail closed. §6.6 routes a session's destruction through an approval,
          // and an approval belongs to a session record — so an actor naming a
          // session this store has never seen has no way to ask, and executing
          // anyway would be the one destructive path with nothing behind it.
          throw forbidden(
            `${routing.verdict.reason} — and this call is attributed to ${actor.sessionId}, which is not a session on record, so there is nobody to raise the approval for (§6.6)`,
          );
        }

        const approval = deps.approvals.raise({
          sessionId: actor.sessionId,
          ask: routing.verdict.ask,
          pierced: routing.verdict.pierced,
        });

        deps.logger.info("a destructive gesture raised an approval", {
          sessionId: actor.sessionId,
          tool: matched.tool.name,
          targetId: matched.targetId,
          approvalId: approval.id,
        });

        // 202: the gesture was accepted and is waiting on a person, which is
        // neither a success (nothing was deleted) nor a refusal (nothing said
        // no). The row the operator will answer travels back, so a session can
        // say what it is waiting for.
        return c.json(
          {
            approval,
            attention: approvalAttention(approval),
            executed: false,
            reason: routing.verdict.reason,
          },
          202,
        );
      }
    }
  };
}
