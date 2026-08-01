import { Hono } from "hono";
import { z } from "zod";
import {
  BATCH_GESTURE_KINDS,
  pathsNotTaken,
  SESSION_BROADCAST_CATEGORIES,
  STOP_SCOPE_KINDS,
  type HumanBroadcastTarget,
  type RepositoryId,
  type SessionBroadcastScope,
  type SessionId,
  type StopScope,
  type WorkspaceId,
  type WorkstreamId,
} from "@plotroom/core";
import { badRequest } from "../http/errors.js";
import { validateJsonBody } from "../http/validate.js";
import type { SteeringService } from "../sessions/steering.js";
import { actorOf, body, param, type ApiEnv, type ApiStores } from "./api.js";

/**
 * Steering in flight, as endpoints (§6.5, §6.4, §4.2, §6.7).
 *
 * Every one of these is a tool in `@plotroom/core`'s catalog — declared there
 * before it existed here and `pending` until this file appeared, which the
 * catalog's own test enforces in both directions. Nothing below decides anything:
 * the planners in `core` decide, and a route reports what they said, so an agent's
 * `session_inject` and the composer reach identical verdicts (principle 8).
 */
const injectBody = z.object({
  text: z.string().min(1),
  /** The caller's own name for this gesture; the same id is the same turn. */
  injectionId: z.string().min(1).optional(),
});

const askBody = z.object({
  text: z.string().min(1),
  /**
   * Labels or full options. Labels are the common case and `optionsFromLabels`
   * derives stable ids for them; a caller that wants its own ids passes objects.
   */
  options: z
    .union([
      z.array(z.string().min(1)).min(1),
      z
        .array(
          z.object({
            id: z.string().min(1),
            label: z.string().min(1),
            /** One line of "what this would mean" (§6.4). */
            detail: z.string().nullable().default(null),
          }),
        )
        .min(1),
    ])
    .refine((options) => options.length > 0, "a question needs options"),
  freeForm: z.enum(["none", "allowed"]).optional(),
  /**
   * Escalation only. It NEVER resolves the question: §6.4 forbids a timed default
   * and core's own types make one inexpressible — this raises the attention level
   * and nothing else.
   */
  escalateAfterSeconds: z.number().int().positive().optional(),
  questionId: z.string().min(1).optional(),
});

const answerBody = z.object({
  optionId: z.string().min(1),
  text: z.string().optional(),
});

const broadcastBody = z.object({
  text: z.string().min(1),
  broadcastId: z.string().min(1).optional(),
  /** The operator's target list. A session may not name recipients (§6.5). */
  target: z
    .union([
      z.object({
        kind: z.literal("selection"),
        sessionIds: z.array(z.string().min(1)).min(1),
      }),
      z.object({
        kind: z.literal("workstream"),
        workstreamId: z.string().min(1),
      }),
      z.object({ kind: z.literal("everything-running") }),
    ])
    .optional(),
  /** A session's declared scope of shared material state (§6.5). */
  scope: z
    .union([
      z.object({
        kind: z.literal("everyone-in-repository"),
        repositoryId: z.string().min(1),
      }),
      z.object({
        kind: z.literal("everyone-in-workspace"),
        workspaceId: z.string().min(1),
      }),
    ])
    .optional(),
  category: z.enum(SESSION_BROADCAST_CATEGORIES).optional(),
});

const batchBody = z.object({
  kind: z.enum(BATCH_GESTURE_KINDS),
  sessionIds: z.array(z.string().min(1)).min(1),
  batchKey: z.string().min(1),
  prompt: z.string().optional(),
});

const stopBody = z.object({
  scope: z.enum(STOP_SCOPE_KINDS),
  sessionId: z.string().min(1).optional(),
  workstreamId: z.string().min(1).optional(),
  /** Required at the widest scope, which confirms before it acts (§6.7). */
  confirm: z.boolean().default(false),
});

function toStopScope(input: z.infer<typeof stopBody>): StopScope {
  switch (input.scope) {
    case "session":
      if (input.sessionId === undefined) {
        throw badRequest("the session scope names the session to stop");
      }
      return { kind: "session", sessionId: input.sessionId as SessionId };
    case "workstream":
      if (input.workstreamId === undefined) {
        throw badRequest("the workstream scope names the workstream to stop");
      }
      return {
        kind: "workstream",
        workstreamId: input.workstreamId as WorkstreamId,
      };
    case "everything":
      return { kind: "everything" };
  }
}

export function steeringRoutes(
  stores: ApiStores,
  steering: SteeringService,
): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  /**
   * Add content to a running session mid-flight (§6.5). It arrives as a new turn
   * **and** stays on the graph, wired to the session, attributed — all three, or
   * the gesture did not happen.
   *
   * A session may call this into an out-of-chain peer; `checkInjection`'s lineage
   * half refuses its own chain (principle 1), and the refusal is that predicate's.
   *
   * `queued` is what success reports. Delivery is the separate observed fact, so a
   * surface renders queued versus delivered from the ledger rather than assuming.
   */
  app.post("/sessions/:id/inject", validateJsonBody(injectBody), async (c) => {
    const input = body<z.infer<typeof injectBody>>(c);
    const result = await steering.inject({
      sessionId: param(c, "id"),
      text: input.text,
      actor: actorOf(c),
      ...(input.injectionId === undefined
        ? {}
        : { injectionId: input.injectionId }),
    });

    return c.json(result, result.replayed ? 200 : 201);
  });

  /** The ledger for one session: queued, delivered, refused (§6.5). */
  app.get("/sessions/:id/injections", (c) => {
    const id = param(c, "id");
    stores.sessions.get(id);
    return c.json({
      sessionId: id,
      injections: stores.sessions.injections(id),
    });
  });

  /**
   * Ask the operator a structured question (§6.4). Options are selectable and the
   * answer comes back structurally; **no timeout of any kind** is accepted, and
   * `escalateAfterSeconds` only raises the attention level.
   */
  app.post("/sessions/:id/questions", validateJsonBody(askBody), (c) => {
    const input = body<z.infer<typeof askBody>>(c);
    const question = steering.raise({
      sessionId: param(c, "id"),
      text: input.text,
      options: input.options,
      ...(input.freeForm === undefined ? {} : { freeForm: input.freeForm }),
      ...(input.escalateAfterSeconds === undefined
        ? {}
        : { escalateAfterSeconds: input.escalateAfterSeconds }),
      ...(input.questionId === undefined
        ? {}
        : { questionId: input.questionId }),
    });

    return c.json({ question, pathsNotTaken: pathsNotTaken(question) }, 201);
  });

  /** Every question a session asked, answered or not — the bubbles' own source. */
  app.get("/sessions/:id/questions", (c) => {
    const id = param(c, "id");
    stores.sessions.get(id);
    const questions = stores.questions.forSession(id);
    return c.json({
      sessionId: id,
      questions: questions.map((question) => ({
        question,
        // Derived, never stored: a stored list could disagree with the options.
        pathsNotTaken: pathsNotTaken(question),
      })),
    });
  });

  /**
   * Answer one. The operator's alone (§6.4) — a session answering a question posed
   * to the user would be principle 1 with extra steps, and `answerQuestion`
   * refuses it.
   *
   * The blocked runtime call is settled with the picked option's label; the
   * structured payload, paths not taken included, comes back here and in the event.
   */
  app.post("/questions/:id/answer", validateJsonBody(answerBody), async (c) => {
    const input = body<z.infer<typeof answerBody>>(c);
    const result = await steering.answer({
      questionId: param(c, "id"),
      optionId: input.optionId,
      ...(input.text === undefined ? {} : { text: input.text }),
      actor: actorOf(c),
    });

    return c.json({
      question: result.question,
      answer: result.encoded,
      pathsNotTaken: pathsNotTaken(result.question),
      /** False when nothing was blocked on it — an HTTP-raised question. */
      settled: result.settled,
    });
  });

  /**
   * Broadcast (§6.5). The actor decides which of the two this is: the operator
   * names a target list and is unconstrained; a session declares a **scope of
   * shared material state** it stands in, carries a mandatory category, is bounded
   * per window, and pays for what it induces.
   */
  app.post("/broadcasts", validateJsonBody(broadcastBody), async (c) => {
    const input = body<z.infer<typeof broadcastBody>>(c);
    const actor = actorOf(c);

    if (actor.kind === "session" && input.target !== undefined) {
      // §6.5's whole point: a session names a scope, never recipients. Refused
      // rather than reinterpreted, so the attempt is visible.
      throw badRequest(
        "a session broadcasts to a scope of shared material state, not to a list of recipients (§6.5)",
      );
    }

    const result = await steering.broadcast({
      actor,
      text: input.text,
      ...(input.broadcastId === undefined
        ? {}
        : { broadcastId: input.broadcastId }),
      ...(input.target === undefined
        ? {}
        : { target: input.target as HumanBroadcastTarget }),
      ...(input.scope === undefined ? {} : { scope: toScope(input.scope) }),
      ...(input.category === undefined ? {} : { category: input.category }),
    });

    return c.json(
      {
        broadcastId: result.plan.broadcastId,
        origin: result.plan.origin,
        category: result.plan.category,
        recipients: result.deliveries.map((delivery, index) => ({
          sessionId: result.plan.deliveries[index]?.sessionId ?? null,
          injectionId: delivery.injectionId,
          status: delivery.status,
          refusedReason: delivery.refusedReason,
        })),
        /** Whose budgets the induced turns are charged to (§6.5, principle 2). */
        spendChargedTo: result.plan.spendChargedTo,
        contentNodeId: result.plan.content.nodeId,
        /** True when this key had already sent it: the same answer, not a second send. */
        replayed: result.replayed,
      },
      result.replayed ? 200 : 201,
    );
  });

  /**
   * The world a broadcast scope is judged against (§6.5): which sessions are
   * running, in which workstream and workspace, standing in which repositories.
   *
   * A read, and the one a sender needs before it can declare a scope at all — a
   * session cannot name "everyone in this repository" without knowing what this
   * repository is called. It is also where the operator can see the join the plan
   * flags as the loose input: if `repositoryIds` were wrong, this is where it would
   * be visibly wrong rather than silently widening what a session may declare.
   */
  app.get("/broadcast-world", (c) => c.json(steering.world()));

  /**
   * What a stop would cover, without making it (§6.7): the count the gesture names
   * first, whether it is enabled at all, and whether it confirms.
   *
   * A GET, because it is the button's own state and looking must be free.
   */
  app.get("/stops/preview", (c) => {
    const scope = c.req.query("scope");
    const parsed = z.enum(STOP_SCOPE_KINDS).safeParse(scope);
    if (!parsed.success) {
      throw badRequest(
        `scope must be one of ${STOP_SCOPE_KINDS.join(", ")} (got ${JSON.stringify(scope)})`,
      );
    }

    return c.json(
      steering.planStop(
        toStopScope({
          scope: parsed.data,
          confirm: false,
          ...(c.req.query("sessionId") === undefined
            ? {}
            : { sessionId: c.req.query("sessionId") }),
          ...(c.req.query("workstreamId") === undefined
            ? {}
            : { workstreamId: c.req.query("workstreamId") }),
        }),
      ),
    );
  });

  /** Stop at a scope (§6.7). The widest one confirms, and is refused without it. */
  app.post("/stops", validateJsonBody(stopBody), async (c) => {
    const input = body<z.infer<typeof stopBody>>(c);
    const result = await steering.stop({
      scope: toStopScope(input),
      confirm: input.confirm,
      actor: actorOf(c),
    });

    return c.json({ plan: result.plan, stopped: result.stopped });
  });

  /**
   * One gesture over a multi-selection (§4.2): one prompt to many, stop, close, or
   * archive. Partial by design — a member that cannot take the gesture is skipped
   * with a reason rather than failing the rest, and `skipped` travels verbatim.
   */
  app.post("/batches", validateJsonBody(batchBody), async (c) => {
    const input = body<z.infer<typeof batchBody>>(c);
    const result = await steering.batch({
      batchKey: input.batchKey,
      kind: input.kind,
      sessionIds: input.sessionIds,
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      actor: actorOf(c),
    });

    return c.json(
      {
        batchKey: result.plan.batchKey,
        kind: result.plan.kind,
        members: result.performed,
        skipped: result.plan.skipped,
      },
      201,
    );
  });

  return app;
}

function toScope(
  scope: NonNullable<z.infer<typeof broadcastBody>["scope"]>,
): SessionBroadcastScope {
  return scope.kind === "everyone-in-repository"
    ? {
        kind: "everyone-in-repository",
        repositoryId: scope.repositoryId as RepositoryId,
      }
    : {
        kind: "everyone-in-workspace",
        workspaceId: scope.workspaceId as WorkspaceId,
      };
}
