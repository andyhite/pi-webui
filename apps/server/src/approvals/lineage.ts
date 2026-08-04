import type { MiddlewareHandler } from "hono";
import { checkToolCall, sessionTargetedTools } from "@plotroom/core";
import { refused } from "../http/errors.js";
import type { Logger } from "../logging/logger.js";
import { createToolTargetIndex } from "../runs/delegation.js";
import { actorOf, type ApiEnv, type ApiStores } from "../routes/api.js";
import { matchToolRoute, toolRoutes } from "./routes.js";

/**
 * Principle 1 on the session-authored HTTP path (§4.1, cross-cutting rule 3).
 *
 * "A session may not author intent into itself, its ancestors, or its descendants
 * — it cannot wire its own inputs, grant itself capabilities, raise its own
 * budget, or route around any of this through a chain it started."
 *
 * The catalog declares that class per tool (`requires.reflexivity`) and
 * `checkToolCall` is the refusal, but over HTTP that predicate was reached only
 * where a gesture resolves its own scope: `checkRunGesture` calls it for the run
 * spine, resume, fork, and the scoped stop, and `checkInjection` and `planBatch`
 * reach the same lineage rule through `checkAuthoring` directly. The three
 * single-session verbs reached neither: `session_stop`, `session_end` and
 * `session_delete` carried a declared lineage class that bound nothing, which is
 * the failure "enforced, not documented" exists to prevent (issue #75).
 *
 * **Why this is a refusal and not an approval.** §6.6's channel is for capability
 * a session does not have; principle 1 is capability a session cannot be given at
 * all, and `checkToolCall` refuses rather than asking. Making the HTTP path ask
 * instead would be a second semantics for one rule, and the surfaces would differ
 * on the same call — the thing principle 8 rules out. Nothing is taken from the
 * operator: a human actor is unconstrained, so the operator can still stop, end,
 * or delete a session in any chain.
 *
 * **Why it is mounted before `destructionGuard`.** A pre-grant matches by approval
 * kind and tool pattern and never by target, so one "allow always" over
 * `session_delete` evaluated first would cover a delete inside the granting
 * session's own chain, silently. Ordering the two guards is what closes that: the
 * question of whether the gesture is refused outright is settled before the
 * question of who may answer for it.
 *
 * **What it covers, and why not more.** `sessionTargetedTools()` — the
 * lineage-checked tools whose target is the session their path names, which is
 * exactly the set whose declared resolution is "the session named by the id, and
 * nothing else". The resolution is therefore right rather than close, and it is
 * the existing `ToolTargetIndex` that answers it, not a second reading of the
 * graph. Every other lineage-checked tool names something a path cannot resolve
 * to a session — a queue entry, a batch, a workstream, a body of node ids — and a
 * guard that treated one of those ids as the lineage target would refuse the wrong
 * calls; those keep being checked where their scope resolves.
 *
 * **Three of the six were already refused, and this changes their wording and
 * their precedence.** `session_inject`, `session_resume` and `session_fork` are
 * checked at their call sites (`checkInjection`, `checkRunGesture`), so the guard
 * answers first and its sentence is `checkToolCall`'s rather than
 * `checkAuthoring`'s. That moves one ordering deliberately: an own-chain injection
 * into an *ended* session used to answer `session_not_running`, because
 * `checkInjection` asks whether the session accepts one before it asks whose chain
 * it is in. It now answers `own_chain`, which is the more honest of the two —
 * principle 1 does not become true when the target starts running.
 *
 * **Where the product deliberately says the opposite.** `POST /api/batches` with
 * `kind: "stop"` or `"close"` performs the same effect on an own-chain session and
 * is **not** lineage-checked, by a recorded decision: `authorsIntent` in
 * `core/sessions/batch.ts` covers the injecting kind only, because "stop, close and
 * archive take capability away, and the asymmetry principle 1 protects is about a
 * session expanding what it knows or may do". That decision states the boundary
 * this file sits on the other side of in as many words — "`session_stop`'s own
 * catalog entry keeps its lineage class for the same reason it always had one
 * (stopping a peer to escape a gate), and this narrowing is scoped to the batch
 * envelope" — so the single verb refusing while the batch envelope allows is the
 * shape that was decided, not an oversight to reconcile here.
 */
export interface SessionLineageGuardDeps {
  readonly stores: ApiStores;
  readonly logger: Logger;
}

export function sessionLineageGuard(
  deps: SessionLineageGuardDeps,
): MiddlewareHandler<ApiEnv> {
  const routes = toolRoutes(
    sessionTargetedTools(),
    deps.logger,
    "principle 1 refuses a session's call into its own chain by the session its endpoint names; a tool with anything but one path parameter names no single session, so this route is not guarded",
  );

  return async (c, next) => {
    const actor = actorOf(c);
    if (actor.kind !== "session") return next();

    const matched = matchToolRoute(routes, c.req.method, c.req.path);
    if (matched === null) return next();

    const check = checkToolCall(
      {
        actor,
        lineage: deps.stores.graph.lineageIndex(),
        targets: createToolTargetIndex(deps.stores),
      },
      {
        tool: matched.tool.name,
        // `sessionId`, matching `checkRunGesture`'s call. `checkToolCall` reads the
        // target rather than the input, so this names the field the tool declares
        // instead of inventing a second spelling for one id.
        input: { sessionId: matched.targetId },
        target: { kind: "session", id: matched.targetId },
      },
    );

    if (!check.allowed) {
      // Logged because this is the one refusal that overrides a standing decision
      // the operator wrote: a session hammering at its parent under its own
      // "allow always" leaves no approval and no attention item, so without this
      // line it leaves no trace at all (§8).
      deps.logger.info("a session's own-chain gesture was refused", {
        sessionId: actor.sessionId,
        tool: matched.tool.name,
        targetId: matched.targetId,
        reason: check.refusal.reason,
      });

      // The predicate's own reason and message, unchanged, so the refusal an
      // agent parses is the one the canvas shows (principle 8).
      throw refused({
        reason: check.refusal.reason,
        message: check.refusal.message,
      });
    }

    return next();
  };
}
