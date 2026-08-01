import { Hono } from "hono";
import { z } from "zod";
import { badRequest } from "../http/errors.js";
import { validateJsonBody } from "../http/validate.js";
import type { ContinuationService } from "../sessions/continuation.js";
import { actorOf, body, param, type ApiEnv, type ApiStores } from "./api.js";

/**
 * Resume, fork, and handoff, as endpoints (§6.3, §4.3).
 *
 * The §6.3 choice is explicit here in the shape of the API itself: there are two
 * endpoints and no third, and neither is reachable by typing into a session —
 * which is what "never an implicit consequence of typing into it" means once it
 * leaves `dispositionOfTypedInput` and becomes a transport.
 */
const resumeBody = z.object({
  /** Delivered as the resumed session's first turn; omit to just reopen it. */
  firstTurn: z.string().min(1).optional(),
  initiationKey: z.string().min(1),
});

const forkBody = z.object({
  /** The fork inherits everything up to and including this turn (§6.3). */
  turn: z.number().int().positive(),
  initiationKey: z.string().min(1),
});

const briefBody = z.object({
  /** Omit to derive one from the log, labelled as derived and paraphrasing nothing. */
  text: z.string().optional(),
  briefId: z.string().min(1).optional(),
});

const reviewBody = z.object({
  /** The words as the operator wants them sent; omit to send the draft unchanged. */
  text: z.string().min(1).optional(),
});

const handoffBody = z.object({
  briefId: z.string().min(1),
  workstreamId: z.string().min(1),
  initiationKey: z.string().min(1),
});

export function continuationRoutes(
  stores: ApiStores,
  continuation: ContinuationService,
): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  /**
   * Resume an ended session (§6.3): the **same record** continues, which is the
   * whole difference from a fork.
   *
   * §4.3's forced-fresh gate is applied here and cannot be skipped: the divergence
   * report is computed from the workspace as it stands, and a diverged workspace is
   * refused in the gate's own words — "the session's mental picture is stale in a
   * way no update can repair".
   */
  app.post("/sessions/:id/resume", validateJsonBody(resumeBody), async (c) => {
    const input = body<z.infer<typeof resumeBody>>(c);
    const result = await continuation.resume({
      sessionId: param(c, "id"),
      ...(input.firstTurn === undefined ? {} : { firstTurn: input.firstTurn }),
      initiationKey: input.initiationKey,
      actor: actorOf(c),
    });

    return c.json(
      {
        session: result.session.session,
        firstTurnQueued: result.firstTurnQueued,
        replayed: result.replayed,
      },
      result.replayed ? 200 : 201,
    );
  });

  /**
   * What a fork from a point *would* be, without making one — including how clean
   * the point is (§6.3's fork-before-clean, fork-after-dirty).
   *
   * `cleanliness.state` is `clean | dirty | unknown`, and `unknown` is the honest
   * answer wherever the session called a tool nobody declared: until Phase 7's
   * integrations declare their write reversibility there are no declarations at
   * all, so "nothing was declared" must not read as "nothing happened"
   * (principle 7).
   */
  app.get("/sessions/:id/fork-preview", async (c) => {
    const id = param(c, "id");
    const turn = Number(c.req.query("turn") ?? "");
    if (!Number.isInteger(turn) || turn < 1) {
      throw badRequest("fork-preview names the 1-based turn to fork at");
    }

    const plan = await continuation.planFork(
      stores.sessions.get(id),
      { turn },
      actorOf(c),
    );

    return c.json({
      point: plan.point,
      /** Native or seeded — a seeded fork is never pretended to be native. */
      runtime: plan.runtime,
      cleanliness: plan.cleanliness,
      seedComplete: plan.seedComplete,
      workstreamName: plan.workstream.name,
    });
  });

  /**
   * Fork from a point (§6.3): a new session with its own workstream and workspace,
   * inheriting the conversation up to and including that turn.
   */
  app.post("/sessions/:id/fork", validateJsonBody(forkBody), async (c) => {
    const input = body<z.infer<typeof forkBody>>(c);
    const result = await continuation.fork({
      sessionId: param(c, "id"),
      turn: input.turn,
      initiationKey: input.initiationKey,
      actor: actorOf(c),
    });

    return c.json(
      {
        session: result.session.session,
        workstreamId: result.session.session.workstreamId,
        /** The branch that actually ran, not the one that was planned. */
        mode: result.mode,
        cleanliness: result.plan.cleanliness,
        seedComplete: result.plan.seedComplete,
        replayed: result.replayed,
      },
      result.replayed ? 200 : 201,
    );
  });

  /**
   * Write the brief a handoff opens with (§6.3). **Writing one sends nothing** —
   * the operator reviews it first, and the review is a separate interaction because
   * "the human edits before sending" is a step, not a flag.
   */
  app.post("/sessions/:id/handoff-brief", validateJsonBody(briefBody), (c) => {
    const input = body<z.infer<typeof briefBody>>(c);
    const brief = continuation.writeBrief({
      sessionId: param(c, "id"),
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.briefId === undefined ? {} : { briefId: input.briefId }),
      actor: actorOf(c),
    });

    return c.json({ brief }, 201);
  });

  /** The briefs a session has written, so the operator can pick one up later. */
  app.get("/sessions/:id/handoff-briefs", (c) => {
    const id = param(c, "id");
    stores.sessions.get(id);
    return c.json({
      sessionId: id,
      briefs: stores.broadcasts
        .briefsFor(id)
        .map((row) => stores.broadcasts.toBrief(row)),
    });
  });

  /**
   * The human's review — the only path from a draft to something sendable (§6.3).
   * The operator's alone: `reviewHandoffBrief` refuses a session author, because a
   * session approving its own brief is the review not happening.
   */
  app.post("/handoff-briefs/:id/review", validateJsonBody(reviewBody), (c) => {
    const input = body<z.infer<typeof reviewBody>>(c);
    const brief = continuation.reviewBrief({
      briefId: param(c, "id"),
      ...(input.text === undefined ? {} : { text: input.text }),
      actor: actorOf(c),
    });

    return c.json({ brief });
  });

  /**
   * Send a reviewed brief (§6.3): it seeds a new session, and stays on the graph as
   * content wired in by **the reviewer** — the human decided this session should
   * know this, which is what §15-2 records.
   */
  app.post("/handoffs", validateJsonBody(handoffBody), async (c) => {
    const input = body<z.infer<typeof handoffBody>>(c);
    const result = await continuation.handoff({
      briefId: input.briefId,
      workstreamId: input.workstreamId,
      initiationKey: input.initiationKey,
      actor: actorOf(c),
    });

    return c.json(
      {
        session: result.session.session,
        briefNodeId: result.briefNodeId,
        replayed: result.replayed,
      },
      result.replayed ? 200 : 201,
    );
  });

  /**
   * §4.3's decision, side by side: what continuing sends against what a fresh run
   * sends, each mode's own gates, and the reason a refused one is refused.
   *
   * A read on the command, beside its run preview: "the run preview shows the cost
   * of both options side by side, and the human chooses".
   */
  app.get("/commands/:id/continuation", async (c) =>
    c.json(await continuation.continueVsFresh(param(c, "id"))),
  );

  return app;
}
