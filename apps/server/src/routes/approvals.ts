import { Hono } from "hono";
import { z } from "zod";
import {
  APPROVAL_KINDS,
  APPROVAL_WRITE_EXTENTS,
  approvalAttention,
  type Approval,
} from "@plotroom/core";
import type { ApprovalService } from "../approvals/service.js";
import { badRequest } from "../http/errors.js";
import { validateJsonBody } from "../http/validate.js";
import { actorOf, body, param, type ApiEnv } from "./api.js";

/**
 * Approvals as endpoints (§6.6, Epic 6.3's server half).
 *
 * These are the operator's own gestures and they have **no agent tool at all**,
 * for the reason budgets have none: principle 1 says a session "cannot wire its
 * own inputs, grant itself capabilities, or raise its own budget", and answering
 * the approval that gates you, or declaring the standing grant that would have
 * answered it, is granting yourself capability in two words instead of one.
 * `answerApproval` and `declarePreGrant` refuse a session author outright; these
 * routes are where that refusal is reachable, not where it is decided.
 *
 * The queue answers from here **without opening the session** (§7.1): the row
 * carries the ask, and this takes the decision.
 */
const answerBody = z.object({
  decision: z.enum(["approve-once", "deny"]),
  /** Required for a deny: feedback the session acts on, never a bare refusal. */
  reason: z.string().min(1).optional(),
});

const preGrantBody = z.object({
  scope: z.union([
    z.object({
      kind: z.literal("session"),
      sessionId: z.string().min(1),
    }),
    z.object({
      kind: z.literal("workstream"),
      workstreamId: z.string().min(1),
    }),
  ]),
  effect: z.enum(["allow", "deny"]),
  /** Named explicitly: "let it write files" and "let it delete my workstreams"
   * are not the same decision, and a grant covering every kind because a field
   * was left out would be the second one by accident. */
  kinds: z.array(z.enum(APPROVAL_KINDS)).min(1),
  toolPattern: z.string().min(1),
  extents: z.array(z.enum(APPROVAL_WRITE_EXTENTS)).min(1).optional(),
});

export function approvalRoutes(approvals: ApprovalService): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  /**
   * What is asking right now (§7.1). The attention row travels beside the
   * record, so the queue and this endpoint word one approval the same way.
   */
  app.get("/approvals", (c) => {
    const sessionId = c.req.query("sessionId");
    const status = c.req.query("status") ?? "pending";
    if (status !== "pending" && status !== "all") {
      throw badRequest(`status must be "pending" or "all" (got ${status})`);
    }

    const rows: readonly Approval[] =
      status === "all"
        ? sessionId === undefined
          ? approvals.pending()
          : approvals.forSession(sessionId)
        : approvals.pending(sessionId);

    return c.json({
      approvals: rows.map((approval) => ({
        approval,
        attention: approvalAttention(approval),
      })),
    });
  });

  app.get("/approvals/:id", (c) => {
    const approval = approvals.get(param(c, "id"));
    return c.json({ approval, attention: approvalAttention(approval) });
  });

  /**
   * Answer one. Two answers only — approve **once**, or deny **with a reason**
   * — and the first answer wins: a second is refused rather than allowed to
   * rewrite what a session was permitted to do (principle 9).
   *
   * `settled` says whether a blocked runtime call was told; `executed` says
   * whether approving performed the destruction it authorized, attributed to the
   * session that asked rather than to the operator who agreed; `effectFailure`
   * says why it did not, when it did not. The last one is not derivable from the
   * first two — a denial and a failed destruction both report `executed: false`,
   * and they are not the same event.
   */
  app.post("/approvals/:id/answer", validateJsonBody(answerBody), async (c) => {
    const input = body<z.infer<typeof answerBody>>(c);
    const result = await approvals.answer({
      approvalId: param(c, "id"),
      decision: input.decision,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      actor: actorOf(c),
    });

    return c.json({
      approval: result.approval,
      settled: result.settled,
      executed: result.executed,
      effectFailure: result.effectFailure,
    });
  });

  /**
   * Every standing decision, withdrawn ones included (§6.6). The operator's own
   * list: which capabilities have been granted in advance is a statement about
   * what sessions may do, and a session reading it would only learn which shapes
   * of call to try.
   */
  app.get("/pre-grants", (c) => c.json({ preGrants: approvals.preGrants() }));

  /**
   * Declare one, per session or per workstream — "a human decision about
   * capability made in advance, which is different in kind from a timer that
   * spends". There is no expiry field: a pre-grant is withdrawn by a human or it
   * stands (principle 2).
   */
  app.post("/pre-grants", validateJsonBody(preGrantBody), (c) => {
    const input = body<z.infer<typeof preGrantBody>>(c);
    const preGrant = approvals.declare({
      scope: input.scope,
      effect: input.effect,
      kinds: input.kinds,
      toolPattern: input.toolPattern,
      ...(input.extents === undefined ? {} : { extents: input.extents }),
      actor: actorOf(c),
    });

    return c.json({ preGrant }, 201);
  });

  /** Withdraw one. Retired rather than deleted, like a claim row. */
  app.delete("/pre-grants/:id", (c) =>
    c.json({ preGrant: approvals.withdraw(param(c, "id"), actorOf(c)) }),
  );

  return app;
}
