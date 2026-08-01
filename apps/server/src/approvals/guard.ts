import type { MiddlewareHandler } from "hono";
import {
  approvalAttention,
  destructionTools,
  pathParametersOf,
  type AgentTool,
} from "@plotroom/core";
import { forbidden } from "../http/errors.js";
import type { Logger } from "../logging/logger.js";
import { actorOf, type ApiEnv } from "../routes/api.js";
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
 * and a call this cannot recognise falls through rather than being refused: the
 * store's own `checkDeletion` is the last line, and a refusal here for an unknown
 * route would be this middleware deciding something it was not asked about.
 */
export interface DestructionGuardDeps {
  readonly approvals: ApprovalService;
  readonly logger: Logger;
}

interface GuardedRoute {
  readonly tool: AgentTool;
  readonly segments: readonly string[];
  readonly idIndex: number;
}

/**
 * The routes to guard, derived once from the catalog. Each destruction tool
 * declares exactly one path parameter (the catalog test enforces that every path
 * parameter is a declared input), and that parameter is the record it would
 * remove.
 */
function guardedRoutes(): readonly GuardedRoute[] {
  const routes: GuardedRoute[] = [];

  for (const tool of destructionTools()) {
    const segments = tool.endpoint.split("/");
    const parameters = pathParametersOf(tool.endpoint);
    if (parameters.length !== 1) continue;
    const idIndex = segments.findIndex((segment) => segment.startsWith(":"));
    if (idIndex < 0) continue;
    routes.push({ tool, segments, idIndex });
  }

  return routes;
}

function match(
  routes: readonly GuardedRoute[],
  method: string,
  path: string,
): { readonly tool: AgentTool; readonly targetId: string } | null {
  const segments = path.split("/");

  for (const route of routes) {
    if (route.tool.method !== method) continue;
    if (route.segments.length !== segments.length) continue;
    const matches = route.segments.every(
      (segment, index) =>
        segment.startsWith(":") || segment === segments[index],
    );
    if (!matches) continue;

    const targetId = segments[route.idIndex];
    if (targetId === undefined || targetId.length === 0) continue;
    return { tool: route.tool, targetId };
  }

  return null;
}

export function destructionGuard(
  deps: DestructionGuardDeps,
): MiddlewareHandler<ApiEnv> {
  const routes = guardedRoutes();

  return async (c, next) => {
    const actor = actorOf(c);
    if (actor.kind !== "session") return next();

    const matched = match(routes, c.req.method, c.req.path);
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
