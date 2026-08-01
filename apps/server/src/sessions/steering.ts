import { randomUUID } from "node:crypto";
import {
  answerQuestion,
  attributeBroadcastSpend,
  batchMemberKey,
  broadcastActivity,
  broadcastAttention,
  checkBroadcastRate,
  DEFAULT_SESSION_BROADCAST_POLICY,
  encodeQuestionAnswer,
  escalateAfter,
  optionsFromLabels,
  pathsNotTaken,
  planBatch,
  planHumanBroadcast,
  planInjection,
  planSessionBroadcast,
  questionOutcome,
  raiseQuestion,
  resolveStop,
  systemMillisClock,
  type Author,
  type BatchGestureKind,
  type BatchPlan,
  type BroadcastIds,
  type BroadcastMember,
  type BroadcastPlan,
  type BroadcastRefusal,
  type BroadcastWorld,
  type EdgeId,
  type HumanBroadcastTarget,
  type InjectionId,
  type InjectionPlan,
  type NodeId,
  type ObjectId,
  type QuestionOption,
  type RuntimeRequestId,
  type SessionBroadcastCategory,
  type SessionBroadcastScope,
  type SessionId,
  type SessionQuestion,
  type StopCandidate,
  type StopPlan,
  type StopScope,
  type WorkspaceId,
} from "@plotroom/core";
import {
  broadcastCause,
  type BroadcastRow,
  type StoredSession,
} from "@plotroom/db";
import type { EventBus } from "../events/bus.js";
import { badRequest, refused } from "../http/errors.js";
import type { Logger } from "../logging/logger.js";
import type { ApiStores } from "../routes/api.js";
import { toEdge, toPlacedNode, toPlotObject } from "../routes/mappers.js";
import type { RunService } from "../runs/service.js";
import { attributionChain, checkRunGesture } from "../runs/delegation.js";
import type { SessionHub } from "./hub.js";
import { repositoryIdsOf } from "./world.js";

/**
 * Steering in flight (§6.5, §6.4, §4.2, §6.7) — the server half of Epic 5.2.
 *
 * Every decision here belongs to `@plotroom/core`: `planInjection` decides what an
 * injection leaves on the graph and whether it is allowed, `raiseQuestion` /
 * `answerQuestion` decide what a question is and who may answer it,
 * `planSessionBroadcast` applies all of §6.5's constraints in one place,
 * `planBatch` decides who is skipped, and `resolveStop` decides what a stop
 * covers. This service is the three things a pure planner cannot be: the writes,
 * the runtime calls, and the events.
 *
 * What it does own is the **world** those planners judge against — which sessions
 * are running, in which workstream, in which workspace, standing in which
 * repositories — because core states the rule and deliberately does not own the
 * join (`world.ts`).
 */
export interface SteeringDeps {
  readonly stores: ApiStores;
  readonly bus: EventBus;
  readonly logger: Logger;
  readonly hub: SessionHub;
  readonly runs: RunService;
}

export interface InjectInput {
  readonly sessionId: string;
  readonly text: string;
  readonly actor: Author;
  /** The caller's own name for this gesture (principle 9). */
  readonly injectionId?: string;
}

export interface InjectResult {
  readonly injectionId: string;
  readonly nodeId: string;
  readonly edgeId: string;
  readonly objectId: string;
  /** `queued` here always: delivery is a separate observed fact (§6.5). */
  readonly status: "queued" | "refused";
  readonly refusedReason: string | null;
  readonly replayed: boolean;
}

export class SteeringService {
  constructor(private readonly deps: SteeringDeps) {}

  /* --------------------------------------------------------------- injection */

  /**
   * Add content to a running session mid-flight (§6.5).
   *
   * Three writes and a runtime call, in that order, because the order is the
   * guarantee: the content, the node, and the **authored context edge** land
   * before the runtime is touched, so an injection the runtime refuses still left
   * the paper trail §6.5 requires. "Steering is authoring" — a plan that leaves no
   * trace is not representable, and neither is a delivery nothing recorded.
   *
   * `queued` is what this returns even on success. Delivery is the separate
   * observed fact (`injection-delivered`), folded by the driver, published as a
   * `session` update — which is what lets a surface show queued versus delivered
   * rather than guessing (§6.5).
   */
  async inject(input: InjectInput): Promise<InjectResult> {
    const { stores } = this.deps;
    const stored = stores.sessions.get(input.sessionId);
    const injectionId = (input.injectionId ??
      `inj_${randomUUID()}`) as InjectionId;

    // One gesture, one injection (principle 9). The ledger is the record, so a
    // replayed id answers from it rather than writing a second turn.
    const existing = stores.sessions
      .injections(input.sessionId)
      .find((entry) => entry.id === injectionId);
    if (existing !== undefined) {
      return {
        injectionId,
        nodeId: existing.nodeId ?? "",
        edgeId: "",
        objectId: "",
        status: existing.refusedAt === null ? "queued" : "refused",
        refusedReason: existing.refusedReason,
        replayed: true,
      };
    }

    const targetNode = stores.graph.nodeFor("session", input.sessionId);
    const plan = planInjection(stores.graph.lineageIndex(), stored.session, {
      ids: {
        injectionId,
        objectId: `obj_${randomUUID()}` as ObjectId,
        nodeId: `node_${randomUUID()}` as NodeId,
        edgeId: `edge_${randomUUID()}` as EdgeId,
      },
      targetNodeId: targetNode.id as NodeId,
      author: input.actor,
      text: input.text,
      // Assembly order into the session: after everything already wired to it.
      ordinal: stores.graph.contextInputs(targetNode.id).length + 1,
      at: stores.clock(),
    });

    if (!plan.ok) {
      // The predicate's own reason — `own_chain` from the lineage rule,
      // `session_not_running` from §3.7's legality of an edge into a session.
      throw refused(plan.refusal);
    }

    return this.deliver(plan.plan, input.actor);
  }

  /**
   * Persist one planned injection and hand it to the runtime.
   *
   * Shared by injection and broadcast, because a broadcast **is** n injections of
   * one content object (§6.5): the content and node are written once by the
   * caller, and each recipient gets its own edge, ledger row, and runtime call.
   */
  private async deliver(
    plan: InjectionPlan,
    actor: Author,
    options: { readonly contentAlreadyWritten?: boolean } = {},
  ): Promise<InjectResult> {
    const { stores, bus } = this.deps;

    if (options.contentAlreadyWritten !== true) {
      // An injection's content belongs to the workstream whose session it steers.
      this.writeContent(plan.content, actor, {
        workstreamId: plan.workstreamId,
      });
    }

    const edge = stores.graph.addContextEdge({
      edgeId: plan.edge.id,
      from: plan.content.nodeId,
      to: plan.edge.to,
      author: plan.edge.author,
      ordinal: plan.edge.ordinal,
    });
    bus.publish({
      entity: "edge",
      verb: "created",
      edge: toEdge(edge),
      author: actor,
    });

    stores.sessions.queueInjection({
      id: plan.ledgerEntry.id,
      sessionId: plan.sessionId,
      origin: "steering",
      author: plan.ledgerEntry.author,
      nodeId: plan.content.nodeId,
      text: plan.ledgerEntry.text,
      queuedAt: plan.ledgerEntry.queuedAt,
    });
    this.publishSession(plan.sessionId, actor);

    const live = this.deps.hub.get(plan.sessionId);
    if (!live) {
      // Recorded as refused rather than left queued for ever: the graph keeps the
      // content (somebody authored it), and the ledger says it never arrived.
      const at = stores.clock();
      stores.sessions.markRefused(
        plan.ledgerEntry.id,
        at,
        "no live runtime is attached to this session, so nothing could receive it",
      );
      this.publishSession(plan.sessionId, actor);
      return {
        injectionId: plan.ledgerEntry.id,
        nodeId: plan.content.nodeId,
        edgeId: edge.id,
        objectId: plan.content.objectId,
        status: "refused",
        refusedReason: "no live runtime is attached to this session",
        replayed: false,
      };
    }

    try {
      // Resolves on queue acceptance, never on delivery (decision 0001, §6.5).
      await live.handle.inject({
        id: plan.ledgerEntry.id,
        text: plan.ledgerEntry.text,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stores.sessions.markRefused(plan.ledgerEntry.id, stores.clock(), message);
      this.publishSession(plan.sessionId, actor);
      return {
        injectionId: plan.ledgerEntry.id,
        nodeId: plan.content.nodeId,
        edgeId: edge.id,
        objectId: plan.content.objectId,
        status: "refused",
        refusedReason: message,
        replayed: false,
      };
    }

    return {
      injectionId: plan.ledgerEntry.id,
      nodeId: plan.content.nodeId,
      edgeId: edge.id,
      objectId: plan.content.objectId,
      status: "queued",
      refusedReason: null,
      replayed: false,
    };
  }

  /**
   * The content half: an object with its three renderings, and a node for it.
   *
   * **Scope is the caller's, and the two callers differ for a reason core cannot
   * express.** `InjectionContent` says `local`, which is right for an injection —
   * it belongs to the workstream whose session it steers. A **broadcast** reaches
   * sessions in more than one workstream by construction, and §3.3 refuses a local
   * object outside its own workstream, so its one content object is world-scoped:
   * `InjectionContent` carries no workstream at all, and there is no single
   * workstream a broadcast's content could belong to. Stated here because the
   * shape says `local` and this deliberately does not follow it (§3.2's promotion
   * is the same idea: content many workstreams see is world content).
   */
  private writeContent(
    content: InjectionPlan["content"],
    actor: Author,
    scope: { readonly workstreamId: string | null },
  ): void {
    const { stores, bus } = this.deps;

    const written = stores.objects.write({
      objectId: content.objectId,
      kind: content.kind,
      title: content.title,
      renderings: {
        card: { text: content.title },
        summary: content.title,
        agentContent: content.body,
      },
      ...(scope.workstreamId === null
        ? {}
        : { workstreamId: scope.workstreamId }),
    });

    const object = stores.objects.get(written.objectId);
    if (object !== undefined) {
      bus.publish({
        entity: "object",
        verb: "created",
        object: toPlotObject(object),
        author: actor,
      });
    }

    const node = stores.graph.place({
      nodeId: content.nodeId,
      role: "content",
      refId: written.objectId,
      ...(scope.workstreamId === null
        ? {}
        : { workstreamId: scope.workstreamId }),
    });
    bus.publish({
      entity: "node",
      verb: "created",
      node: toPlacedNode(node),
      author: actor,
    });
  }

  /* --------------------------------------------------------------- questions */

  /**
   * Raise a structured question (§6.4).
   *
   * Two callers, one path: a session asking over HTTP (`session_ask`), and a
   * runtime raising one through its own tool (`plotroom_ask` → a `request-raised`
   * observation the driver hands here). The second carries `requestId`, which is
   * what makes answering settle the blocked call rather than a copy of it.
   *
   * No timeout is accepted, at any level. `escalateAfterSeconds` becomes core's
   * `escalateAfter`, whose only outcome is `escalate-attention` — the type has no
   * variant that resolves a question, so a timed default is not expressible here
   * even by mistake (§6.4, principle 2).
   */
  raise(input: {
    readonly sessionId: string;
    readonly text: string;
    readonly options: readonly string[] | readonly QuestionOption[];
    readonly freeForm?: "none" | "allowed";
    readonly escalateAfterSeconds?: number | null;
    readonly requestId?: string | null;
    readonly questionId?: string;
  }): SessionQuestion {
    const { stores } = this.deps;
    stores.sessions.get(input.sessionId);

    if (input.requestId !== undefined && input.requestId !== null) {
      const already = stores.questions.forRequest(input.requestId);
      // One question per blocked call. A doubled `request-raised` must not raise a
      // second question the operator would have to answer twice.
      if (already !== undefined) return already;
    }

    const options: readonly QuestionOption[] = input.options.every(
      (option) => typeof option === "string",
    )
      ? optionsFromLabels(input.options as readonly string[])
      : (input.options as readonly QuestionOption[]);

    const result = raiseQuestion({
      id: input.questionId ?? `q_${randomUUID()}`,
      sessionId: input.sessionId as SessionId,
      requestId: (input.requestId ?? null) as RuntimeRequestId | null,
      text: input.text,
      options,
      freeForm: input.freeForm ?? "none",
      attention:
        input.escalateAfterSeconds === undefined ||
        input.escalateAfterSeconds === null
          ? null
          : escalateAfter(input.escalateAfterSeconds),
      at: stores.clock(),
    });

    if (!result.ok) throw refused(result.refusal);

    const stored = stores.questions.raise(result.value);
    this.publishQuestion(stored, "created", {
      kind: "session",
      sessionId: input.sessionId as SessionId,
    });
    return stored;
  }

  /**
   * Answer one (§6.4). The operator's alone — `answerQuestion` refuses a session,
   * and this only reports what it said.
   *
   * The blocked runtime call is settled with `questionOutcome`, which is the picked
   * option's **label** because that is the token the runtime's own select returned.
   * The structured payload (`encodeQuestionAnswer`) travels in the answer response
   * and in the event, and it names the paths not taken — the session learns what
   * was declined, not only what was chosen.
   */
  async answer(input: {
    readonly questionId: string;
    readonly optionId: string;
    readonly text?: string | null;
    readonly actor: Author;
  }): Promise<{
    readonly question: SessionQuestion;
    readonly encoded: ReturnType<typeof encodeQuestionAnswer>;
    readonly settled: boolean;
  }> {
    const { stores } = this.deps;
    const question = stores.questions.get(input.questionId);

    const answered = answerQuestion(question, {
      optionId: input.optionId,
      text: input.text ?? null,
      by: input.actor,
      at: stores.clock(),
    });
    if (!answered.ok) throw refused(answered.refusal);

    const saved = stores.questions.save(answered.value);
    this.publishQuestion(saved, "updated", input.actor);

    // Settling the runtime request is what unblocks the tool call the question
    // stands for. A question raised over HTTP has none, and says so rather than
    // pretending to have settled something.
    let settled = false;
    const outcome = questionOutcome(saved);
    const live = this.deps.hub.get(saved.sessionId);
    if (saved.requestId !== null && outcome !== null && live) {
      try {
        await live.handle.respond(saved.requestId, outcome);
        settled = true;
      } catch (error) {
        this.deps.logger.error("a runtime would not take a question answer", {
          sessionId: saved.sessionId,
          questionId: saved.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { question: saved, encoded: encodeQuestionAnswer(saved), settled };
  }

  /* --------------------------------------------------------------- broadcast */

  /**
   * Broadcast (§6.5). The operator's is unconstrained; a session's goes through
   * every constraint §6.5 names, all of them inside `planSessionBroadcast`.
   *
   * The rate window and the world are the two things this supplies: the sends
   * inside the window (so the bound survives a restart) and which sessions stand
   * in which repository and workspace (so a declared scope is a fact about the
   * sender rather than an address).
   */
  async broadcast(input: {
    readonly actor: Author;
    readonly text: string;
    readonly broadcastId?: string;
    readonly target?: HumanBroadcastTarget;
    readonly scope?: SessionBroadcastScope;
    readonly category?: SessionBroadcastCategory;
  }): Promise<{
    readonly plan: BroadcastPlan;
    readonly deliveries: readonly InjectResult[];
    /** True when this key had already sent this broadcast (principle 9). */
    readonly replayed: boolean;
  }> {
    const { stores } = this.deps;
    const broadcastId = input.broadcastId ?? `bcast_${randomUUID()}`;
    const at = stores.clock();
    const world = this.world();

    const ids: BroadcastIds = {
      broadcastId,
      objectId: `obj_${broadcastId}` as ObjectId,
      nodeId: `node_${broadcastId}` as NodeId,
      // Derived from the broadcast id, so a replay writes the same rows
      // (principle 9) without a table of generated ids. The ordinal is the
      // recipient's own next assembly position (§3.5) rather than a constant: a
      // second broadcast to the same session would otherwise collide with the
      // first at position one, which the schema refuses outright.
      forRecipient: (sessionId) => ({
        injectionId: `inj_${broadcastId}_${sessionId}`,
        edgeId: `edge_${broadcastId}_${sessionId}` as EdgeId,
        ordinal: this.nextOrdinalFor(sessionId),
      }),
    };

    // The same gesture twice is the same gesture, and it answers from what the
    // first one recorded rather than refusing.
    //
    // This used to refuse with `already_sent`, which is a different rule from the one
    // injection, resume, and fork keep — and the divergence was accidental rather
    // than argued: a caller retrying after a dropped response would have been told
    // its broadcast failed when it had landed, which is the failure principle 9
    // exists to prevent. Nothing is re-delivered: the recipients are read back, so
    // the same content is still exactly one turn for every one of them.
    const existing = stores.broadcasts.found(broadcastId);
    if (existing !== undefined) {
      // A replay answers the sender who sent it, not whoever names the id.
      //
      // A broadcast id is the caller's own, so a session guessing or reusing another
      // session's id would otherwise be handed that broadcast's recipient list —
      // which is a read of who is running and sharing state, exactly what §6.5's
      // scope rule exists to stop a session addressing. The operator sees everything
      // by construction (§6.5's whole "operator-visible" clause), so their replay is
      // always allowed.
      const sender = existing.senderSessionId;
      const isSameSender =
        input.actor.kind === "human" ||
        (existing.origin === "session" && sender === input.actor.sessionId);
      if (!isSameSender) {
        throw refused({
          reason: "not_your_broadcast",
          message: `broadcast ${broadcastId} was sent by somebody else; a replay answers the gesture that made it (§6.5)`,
        });
      }
      return this.replayBroadcast(existing);
    }

    const result =
      input.actor.kind === "session"
        ? planSessionBroadcast(
            {
              world,
              history: stores.broadcasts.sendsSince(
                input.actor.sessionId,
                at - (DEFAULT_SESSION_BROADCAST_POLICY.windowSeconds + 1),
              ),
              lineage: stores.graph.lineageIndex(),
            },
            {
              ids,
              senderSessionId: input.actor.sessionId,
              scope: this.requireScope(input.scope),
              category: this.requireCategory(input.category),
              text: input.text,
              at,
            },
          )
        : planHumanBroadcast(world, {
            ids,
            target: input.target ?? { kind: "everything-running" },
            text: input.text,
            at,
          });

    if (!result.ok) throw refused(broadcastRefusalToApi(result.refusal));

    const plan = result.plan;

    // The content once, then one delivery per recipient: "the same content, once"
    // is what makes this a broadcast rather than n injections that read alike.
    // World-scoped: one object wired into sessions across workstreams, which a
    // local object may not be (§3.3). See `writeContent`.
    this.writeContent(plan.content, plan.author, { workstreamId: null });
    // The baseline each recipient had spent before this reached it, so the turn it
    // induces can be told from the work it was already doing (§6.5, principle 2).
    stores.broadcasts.record(
      plan,
      new Map(
        plan.deliveries.map((delivery) => [
          delivery.sessionId as string,
          this.costMicrosOf(delivery.sessionId),
        ]),
      ),
    );

    const deliveries: InjectResult[] = [];
    for (const delivery of plan.deliveries) {
      deliveries.push(
        await this.deliver(
          {
            sessionId: delivery.sessionId,
            workstreamId: delivery.workstreamId,
            content: plan.content,
            edge: delivery.edge,
            ledgerEntry: delivery.ledgerEntry,
          },
          plan.author,
          { contentAlreadyWritten: true },
        ),
      );
    }

    // What the operator sees (§6.5, §7.3): one attention row for a session's send,
    // one activity entry per recipient workstream. Both from core, so the queue and
    // the history cannot describe the same broadcast differently.
    this.deps.bus.publish({
      entity: "broadcast",
      verb: "created",
      broadcastId,
      attention: broadcastAttention(plan),
      activity: broadcastActivity(plan),
      author: plan.author,
    });

    return { plan, deliveries, replayed: false };
  }

  /**
   * A broadcast that already happened, answered from its rows.
   *
   * The plan is reconstructed rather than re-planned: re-planning would evaluate the
   * scope against the world *now*, and a session that started since would appear as
   * a recipient the first send never reached. What was sent is what the recipient
   * rows say was sent.
   */
  private replayBroadcast(existing: BroadcastRow): {
    readonly plan: BroadcastPlan;
    readonly deliveries: readonly InjectResult[];
    readonly replayed: boolean;
  } {
    const { stores } = this.deps;
    const recorded = stores.broadcasts.deliveriesOf(existing.id);
    const author: Author =
      existing.authorKind === "session"
        ? {
            kind: "session",
            sessionId: existing.authorSession as SessionId,
          }
        : { kind: "human" };

    const ledger = new Map(
      recorded.flatMap((delivery) =>
        stores.sessions
          .injections(delivery.sessionId)
          .filter((entry) => entry.id === delivery.injectionId)
          .map((entry) => [delivery.injectionId, entry] as const),
      ),
    );

    return {
      plan: {
        broadcastId: existing.id,
        origin: existing.origin,
        senderSessionId:
          existing.senderSessionId === null
            ? null
            : (existing.senderSessionId as SessionId),
        category: existing.category,
        scope: stores.broadcasts.scopeOf(existing),
        target:
          existing.targetJson === null
            ? null
            : (JSON.parse(existing.targetJson) as HumanBroadcastTarget),
        author,
        text: existing.text,
        content: {
          objectId: existing.objectId as ObjectId,
          nodeId: existing.nodeId as NodeId,
          kind: "note",
          scope: "local",
          title: existing.text,
          body: existing.text,
          createdAt: existing.at,
        },
        deliveries: recorded.map((delivery) => ({
          sessionId: delivery.sessionId,
          workstreamId: delivery.workstreamId,
          edge: {
            id: `edge_${existing.id}_${delivery.sessionId}` as EdgeId,
            kind: "context",
            from: existing.nodeId as NodeId,
            to: existing.nodeId as NodeId,
            author,
            ordinal: 1,
            createdAt: existing.at,
          },
          ledgerEntry: {
            id: delivery.injectionId as InjectionId,
            sessionId: delivery.sessionId,
            author,
            nodeId: existing.nodeId as NodeId,
            text: existing.text,
            queuedAt: existing.at,
          },
        })),
        spendChargedTo:
          existing.senderSessionId === null
            ? []
            : attributionChain(stores, existing.senderSessionId),
        at: existing.at,
      },
      deliveries: recorded.map((delivery) => {
        const entry = ledger.get(delivery.injectionId);
        return {
          injectionId: delivery.injectionId,
          nodeId: existing.nodeId,
          edgeId: `edge_${existing.id}_${delivery.sessionId}`,
          objectId: existing.objectId,
          // The status the ledger recorded, not a fresh guess: a delivery that was
          // refused the first time is still refused (§6.5).
          status: entry?.refusedAt == null ? "queued" : "refused",
          refusedReason: entry?.refusedReason ?? null,
          replayed: true,
        };
      }),
      replayed: true,
    };
  }

  /**
   * Charge a recipient's induced turn to the sender's chain (§6.5, principle 2):
   * "the sender caused it; anything else lets a session spend from budgets that do
   * not bind it, a hole in principle 2's transitive guarantee."
   *
   * Subscribed to the session stream rather than called from the run path, for the
   * same reason the run queue is: the observation that a recipient spent something
   * is already published, and one vocabulary beats a second notification path.
   *
   * **The grain is stated because it is approximate.** What is charged is the
   * recipient's spend between the broadcast reaching it and the next time its
   * accounting moved — the induced turn, to the precision PlotRoom can observe.
   * Charging the recipient's whole session would bill the sender for work it never
   * caused; charging nothing would be the hole §6.5 names. The baseline is a column
   * so a restart between delivery and the turn does not lose the charge, and
   * `induced_micros` makes it a once-only charge: a recipient's own later work is
   * not the sender's fault.
   */
  subscribe(): () => void {
    return this.deps.bus.subscribe((event) => {
      if (event.entity !== "session" || event.verb !== "updated") return;
      try {
        this.chargeInducedSpend(event.session.id);
      } catch (error) {
        this.deps.logger.error("could not charge broadcast-induced spend", {
          sessionId: event.session.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  private chargeInducedSpend(recipientSessionId: string): void {
    const { stores } = this.deps;
    const outstanding = stores.broadcasts.unchargedFor(recipientSessionId);
    if (outstanding.length === 0) return;

    const spentNow = this.costMicrosOf(recipientSessionId);
    const workstreamId = stores.spend.workstreamOf(recipientSessionId);
    if (workstreamId === null) return;

    for (const entry of outstanding) {
      const induced = spentNow - entry.baselineCostMicros;
      // Nothing observed yet: the turn the broadcast induced has not cost anything
      // that PlotRoom has seen, so there is nothing to charge and nothing to close.
      if (induced <= 0) continue;

      const row = stores.broadcasts.found(entry.broadcastId);
      if (row === undefined) continue;

      const spend = {
        sessionId: recipientSessionId as SessionId,
        amountUsd: induced / 1_000_000,
        basis: "reported" as const,
        at: stores.clock(),
      };

      // Who the sender's chain is, minus everyone the accounting fold already
      // charges for this recipient: the recipient itself and its own ancestors are
      // billed for this turn through their own attribution, and charging them here
      // as well would bill one dollar to one budget twice.
      const rows = attributeBroadcastSpend(
        { spendChargedTo: attributionChain(stores, entry.senderSessionId) },
        spend,
        attributionChain(stores, recipientSessionId),
      );
      if (rows.length === 0) {
        // The sender's chain is entirely inside the recipient's own: there is
        // nothing left to charge, and the charge is still closed so the same
        // slice is not reconsidered on the next observation.
        stores.broadcasts.markInduced(
          entry.broadcastId,
          recipientSessionId,
          induced,
        );
        continue;
      }

      stores.spend.attribute({
        chain: rows.map((attribution) => attribution.sessionId),
        workstreamId,
        spend,
        // One cause per broadcast, so a second broadcast from the same sender to
        // the same recipient is a second charge rather than a replacement of the
        // first — and so neither can overwrite the accounting fold's row (§6.5).
        cause: broadcastCause(entry.broadcastId),
      });

      stores.broadcasts.markInduced(
        entry.broadcastId,
        recipientSessionId,
        induced,
      );
    }
  }

  /** What a session has spent, in micros, folded from its observation log. */
  private costMicrosOf(sessionId: string): number {
    const { accounting } =
      this.deps.stores.sessions.observationState(sessionId);
    return Math.round(accounting.costUsd * 1_000_000);
  }

  /** The next assembly position for content wired into this session (§3.5). */
  private nextOrdinalFor(sessionId: string): number {
    const node = this.deps.stores.graph.findNodeFor("session", sessionId);
    if (node === undefined) return 1;
    return this.deps.stores.graph.contextInputs(node.id).length + 1;
  }

  /* -------------------------------------------------------------- stop, batch */

  /**
   * Resolve a stop without making it (§6.7): "names how many it will affect, is
   * disabled when nothing is running, and confirms at the widest scope". All three
   * are `resolveStop`'s answer; this only supplies the candidates.
   */
  planStop(scope: StopScope): StopPlan {
    return resolveStop(this.stopCandidates(), scope);
  }

  /**
   * Make it. The widest scope confirms — refused rather than performed when the
   * confirmation is missing, because §6.7's confirm is a gate and a gate that a
   * caller can forget is a suggestion.
   */
  async stop(input: {
    readonly scope: StopScope;
    readonly confirm: boolean;
    readonly actor: Author;
  }): Promise<{
    readonly plan: StopPlan;
    readonly stopped: readonly string[];
  }> {
    const plan = this.planStop(input.scope);

    if (plan.requiresConfirmation && !input.confirm) {
      throw refused({
        reason: "confirmation_required",
        message: `${plan.description} — confirm to stop everything running (§6.7)`,
      });
    }

    if (!plan.enabled) {
      throw refused({
        reason: "nothing_running",
        message: plan.description,
      });
    }

    // §4.1's lineage rule, over everything the scope resolved to: a session may
    // not stop work inside its own chain to escape a gate, which is what makes the
    // fleet-wide stop unavailable to a session without a second rule.
    checkRunGesture(this.deps.stores, {
      actor: input.actor,
      tool: "stop_scope",
      commandIds: [],
      sessionIds: plan.sessionIds,
    });

    const stopped: string[] = [];
    for (const sessionId of plan.sessionIds) {
      await this.deps.runs.stopSession({
        sessionId,
        mode: "graceful",
        cause: "user",
      });
      stopped.push(sessionId);
    }

    return { plan, stopped };
  }

  /**
   * One gesture over a multi-selection (§4.2). `planBatch` decides who is in and
   * who is skipped and why; this performs the members and reports the skips
   * verbatim, because "a member that cannot take the gesture is skipped with a
   * reason rather than failing the twelve".
   */
  async batch(input: {
    readonly batchKey: string;
    readonly kind: BatchGestureKind;
    readonly sessionIds: readonly string[];
    readonly prompt?: string;
    readonly actor: Author;
  }): Promise<{
    readonly plan: BatchPlan;
    readonly performed: readonly {
      readonly sessionId: string;
      readonly memberKey: string;
      readonly ok: boolean;
      readonly detail: string | null;
    }[];
  }> {
    const { stores } = this.deps;
    const result = planBatch(
      {
        candidates: this.stopCandidates(),
        lineage: stores.graph.lineageIndex(),
      },
      {
        batchKey: input.batchKey,
        kind: input.kind,
        requestedBy: input.actor,
        sessionIds: input.sessionIds as readonly SessionId[],
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
        at: stores.clock(),
      },
    );

    if (!result.ok) {
      throw refused({
        reason: result.refusal.reason,
        message: result.refusal.message,
      });
    }

    const plan = result.plan;
    const performed: {
      sessionId: string;
      memberKey: string;
      ok: boolean;
      detail: string | null;
    }[] = [];

    for (const member of plan.members) {
      const memberKey = batchMemberKey(plan.batchKey, member.sessionId);
      try {
        await this.performBatchMember(plan, member.sessionId, memberKey);
        performed.push({
          sessionId: member.sessionId,
          memberKey,
          ok: true,
          detail: null,
        });
      } catch (error) {
        // Partial by design: one member's refusal is that member's, and the batch
        // reports it rather than failing the eleven that worked (§4.2).
        performed.push({
          sessionId: member.sessionId,
          memberKey,
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { plan, performed };
  }

  private async performBatchMember(
    plan: BatchPlan,
    sessionId: SessionId,
    memberKey: string,
  ): Promise<void> {
    switch (plan.kind) {
      case "inject":
        await this.inject({
          sessionId,
          text: plan.prompt ?? "",
          actor: plan.requestedBy,
          // One prompt to many is n injections, each keyed from the batch key, so a
          // half-failed batch is replayable without doubling anybody's turn.
          injectionId: `inj_${memberKey}`,
        });
        return;

      case "stop":
        await this.deps.runs.stopSession({
          sessionId,
          mode: "graceful",
          cause: "user",
        });
        return;

      case "close":
        await this.deps.runs.endOpenSession(sessionId, plan.requestedBy);
        return;

      case "archive":
        // Archiving is the workstream's verb (§6.8), applied to the session's own
        // workstream: a session is browsable and searchable after it, never hidden.
        this.deps.stores.workstreams.archive(
          this.deps.stores.sessions.get(sessionId).session.workstreamId,
          plan.requestedBy,
        );
        return;
    }
  }

  /* --------------------------------------------------------------- the world */

  /**
   * Which sessions are running, where, and in which material state — the join core
   * states the rule over and does not own (§6.5's `BroadcastWorld`).
   *
   * A repository's identity is its **configured source**, not a generated id: a
   * worktree and the checkout it was branched from are the same repository, which
   * is exactly the fact "everyone in this repository" is about. Deriving it from
   * the workspace's own config means two workspaces agree without a registry, and
   * `senderSharesScope` gets the membership it needs.
   */
  world(): BroadcastWorld {
    const { stores } = this.deps;
    const members: BroadcastMember[] = [];

    for (const stored of stores.sessions.list()) {
      const node = stores.graph.findNodeFor("session", stored.session.id);
      if (node === undefined) continue;

      const workspace =
        stored.workspaceId === null
          ? null
          : stores.workspaces.forWorkstream(stored.session.workstreamId);

      members.push({
        sessionId: stored.session.id,
        workstreamId: stored.session.workstreamId,
        nodeId: node.id as NodeId,
        workspaceId:
          stored.workspaceId === null
            ? null
            : (stored.workspaceId as WorkspaceId),
        repositoryIds: workspace === null ? [] : repositoryIdsOf(workspace),
        running: stored.session.end === null,
      });
    }

    return { members };
  }

  /** Every session a stop or a batch could reach. `BroadcastMember` fits this. */
  stopCandidates(): readonly StopCandidate[] {
    return this.world().members;
  }

  /** How close a sender is to its bound, for a surface that wants to say so. */
  broadcastRate(senderSessionId: string) {
    const at = this.deps.stores.clock();
    return checkBroadcastRate(
      this.deps.stores.broadcasts.sendsSince(
        senderSessionId,
        at - (DEFAULT_SESSION_BROADCAST_POLICY.windowSeconds + 1),
      ),
      senderSessionId as SessionId,
      at,
    );
  }

  /* ---------------------------------------------------------------- private */

  private requireScope(
    scope: SessionBroadcastScope | undefined,
  ): SessionBroadcastScope {
    if (scope === undefined) {
      throw badRequest(
        "a session broadcast names a scope of shared material state, never recipients: everyone-in-repository or everyone-in-workspace (§6.5)",
      );
    }
    return scope;
  }

  private requireCategory(
    category: SessionBroadcastCategory | undefined,
  ): SessionBroadcastCategory {
    if (category === undefined) {
      throw badRequest(
        "a session broadcast declares its category: material-state-changed or shared-resource-warning (§6.5)",
      );
    }
    return category;
  }

  private publishQuestion(
    question: SessionQuestion,
    verb: "created" | "updated",
    author: Author,
  ): void {
    this.deps.bus.publish({
      entity: "session_question",
      verb,
      question,
      pathsNotTaken: pathsNotTaken(question),
      author,
    });
  }

  private publishSession(sessionId: string, author: Author): void {
    const stored: StoredSession = this.deps.stores.sessions.get(sessionId);
    this.deps.bus.publish({
      entity: "session",
      verb: "updated",
      session: stored.session,
      status: this.deps.stores.sessions.status(sessionId, {
        now: systemMillisClock(),
      }),
      author,
    });
  }
}

/** §6.5's refusals, as the API's own shape. Reason and message travel verbatim. */
function broadcastRefusalToApi(refusal: BroadcastRefusal): {
  readonly reason: string;
  readonly message: string;
} {
  return { reason: refusal.reason, message: refusal.message };
}
