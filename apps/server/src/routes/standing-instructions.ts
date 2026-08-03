import { Hono } from "hono";
import { z } from "zod";
import type { ProposalService } from "../standing-instructions/proposals.js";
import type { StandingInstructionService } from "../standing-instructions/service.js";
import { validateJsonBody } from "../http/validate.js";
import { actorOf, body, param, type ApiEnv } from "./api.js";

/**
 * Standing instructions and proposals as endpoints (§3.8, principle 1, Epic 7.4).
 *
 * Every one of these is a tool in `@plotroom/core`'s catalog, declared there before
 * it existed here and marked `pending` until this file appeared — the catalog test is
 * what flips the flag, in both directions. Nothing below decides anything: the store
 * calls core's predicates and a route reports what they said, so an agent's
 * `proposal_create` and the operator's own gesture reach identical verdicts
 * (principle 8).
 *
 * Two shapes are worth stating, because they are not the same shape:
 *
 * - **Declaring or retiring is refused for a session as a refusal, not a 403.** The
 *   answer is "propose it, and a human accepts" (§3.8), and the predicate's own
 *   message names `proposal_create`, so the session's next move is the right one
 *   rather than a retry.
 * - **Accept and reject are the operator's**, enforced by the request's actor inside
 *   `ProposalService` — the convention `ClaimService` and `PluginService` use. There
 *   is no tool for **reject** and there deliberately will not be one: declining is
 *   the operator's word, and a session that could decline proposals could decline its
 *   own.
 */
const declareBody = z.object({
  /** The world-scoped note or document whose content applies everywhere. */
  objectId: z.string().min(1),
});

const optInBody = z.object({
  instructionId: z.string().min(1),
});

const proposeBody = z.object({
  tool: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  rationale: z.string().min(1).optional(),
});

const rejectBody = z.object({
  /** Feedback the session acts on: a bare decline says nothing (§6.6's rule). */
  reason: z.string().min(1).optional(),
});

export function standingInstructionRoutes(
  instructions: StandingInstructionService,
  proposals: ProposalService,
): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  /**
   * What is standing, and which workstreams opted in. Unrestricted, like §8's "a
   * session can see what remains": a session that cannot read the instructions it is
   * running under rediscovers them at a paid turn each, which is the cost §3.8
   * exists to remove.
   */
  app.get("/standing-instructions", (c) =>
    c.json({ standingInstructions: instructions.list() }),
  );

  app.post("/standing-instructions", validateJsonBody(declareBody), (c) => {
    const input = body<z.infer<typeof declareBody>>(c);
    const instruction = instructions.declare({
      objectId: input.objectId,
      actor: actorOf(c),
    });
    return c.json({ standingInstruction: instruction }, 201);
  });

  /** Retire one. The content survives; only the marker stops applying (§3.8). */
  app.delete("/standing-instructions/:id", (c) =>
    c.json({
      standingInstruction: instructions.retire(param(c, "id"), actorOf(c)),
    }),
  );

  app.post(
    "/workstreams/:id/standing-instructions",
    validateJsonBody(optInBody),
    (c) => {
      const input = body<z.infer<typeof optInBody>>(c);
      const optIn = instructions.optIn({
        workstreamId: param(c, "id"),
        instructionId: input.instructionId,
        actor: actorOf(c),
      });
      return c.json({ optIn }, 201);
    },
  );

  app.delete("/workstreams/:id/standing-instructions/:instructionId", (c) =>
    c.json({
      optIn: instructions.optOut({
        workstreamId: param(c, "id"),
        instructionId: param(c, "instructionId"),
        actor: actorOf(c),
      }),
    }),
  );

  /**
   * Propose a change whose target includes you (principle 1). The proposal reaches
   * the operator through §7.1's queue as an approval of its own kind; nothing here
   * applies anything, which is the whole point of the verb.
   */
  app.post("/proposals", validateJsonBody(proposeBody), (c) => {
    const input = body<z.infer<typeof proposeBody>>(c);
    const proposal = proposals.create({
      tool: input.tool,
      input: input.input,
      ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
      actor: actorOf(c),
    });
    return c.json({ proposal }, 201);
  });

  /** Accept it, applying it as the operator's own act (§3.8, §15-2). */
  app.post("/proposals/:id/accept", async (c) => {
    const decided = await proposals.decide({
      proposalId: param(c, "id"),
      decision: "accept",
      actor: actorOf(c),
    });
    return c.json({
      proposal: decided.proposal,
      standingInstruction: decided.instruction,
    });
  });

  /**
   * Decline it. Feedback, not failure: the reason travels to the session the same
   * way an approval denial's does (§6.6).
   */
  app.post("/proposals/:id/reject", validateJsonBody(rejectBody), async (c) => {
    const input = body<z.infer<typeof rejectBody>>(c);
    const decided = await proposals.decide({
      proposalId: param(c, "id"),
      decision: "reject",
      actor: actorOf(c),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    return c.json({ proposal: decided.proposal });
  });

  return app;
}
