import { randomUUID } from "node:crypto";
import {
  compareContinueVsFresh,
  DEFAULT_CONTINUATION_MODE,
  deriveDivergence,
  deriveHandoffBrief,
  deriveOutsideWorldMarkers,
  draftHandoffBrief,
  NO_TOOL_WORLD_DECLARATIONS,
  planHandoff,
  planResume,
  planSessionFork,
  reviewHandoffBrief,
  systemMillisClock,
  type Author,
  type ContinueVsFresh,
  type DivergenceReport,
  type EdgeId,
  type HandoffBrief,
  type NodeId,
  type ObjectId,
  type ReviewedHandoffBrief,
  type SessionForkPlan,
  type SessionId,
  type SessionQuestion,
  type ToolWorldDeclarations,
  type TranscriptPoint,
  type WorkspaceId,
  type WorkstreamId,
} from "@plotroom/core";
import type { StoredSession } from "@plotroom/db";
import type { EventBus } from "../events/bus.js";
import { badRequest, refused } from "../http/errors.js";
import type { Logger } from "../logging/logger.js";
import type { ApiStores } from "../routes/api.js";
import {
  toEdge,
  toPlacedNode,
  toPlotObject,
  toWorkstream,
} from "../routes/mappers.js";
import type { RunService } from "../runs/service.js";
import { checkRunGesture } from "../runs/delegation.js";
import type { SteeringService } from "./steering.js";

/**
 * Resume, fork, and handoff (§6.3, §4.3) — the server half of Epic 5.4.
 *
 * The rules are `@plotroom/core`'s: `planResume` refuses a diverged workspace,
 * `planSessionFork` decides native-versus-seeded and how clean the point is,
 * `reviewHandoffBrief` is the only producer of a brief that may be sent, and
 * `compareContinueVsFresh` describes both options including the one it refuses.
 *
 * Three inputs those planners require and deliberately do not own are this
 * service's, and each was made non-optional by Track C for the same reason: the
 * caller least likely to supply it is the one whose answer would be most
 * misleading.
 *
 * - **Divergence** — the workspace as it stands now against the session's own
 *   fingerprint. `null` only when there is genuinely nothing to compare.
 * - **Outside-world markers** — derived from the session's observation log, so
 *   fork cleanliness comes from declarations rather than a guess.
 * - **Tool world declarations** — empty until Phase 7's integrations declare any,
 *   which is why cleanliness reports `unknown` wherever a session called a tool
 *   nobody declared. That is the honest answer, not a defect.
 */
export interface ContinuationDeps {
  readonly stores: ApiStores;
  readonly bus: EventBus;
  readonly logger: Logger;
  readonly runs: RunService;
  readonly steering: SteeringService;
  /**
   * What each tool does to the outside world (§9.2). Empty today: "until Phase 7
   * there are none, so cleanliness reports uncertainty wherever a session called
   * an undeclared tool" — which `ForkCleanliness.state: "unknown"` says out loud
   * rather than reading absence as innocence (principle 7).
   */
  readonly worldDeclarations?: ToolWorldDeclarations;
}

export class ContinuationService {
  constructor(private readonly deps: ContinuationDeps) {}

  /* ------------------------------------------------------------- divergence */

  /**
   * The workspace as it stands now against what the session recorded — §4.3's
   * forced-fresh gate's only input.
   *
   * `null` means "nothing to compare", and it is a different fact from "nothing
   * changed": a session with no workspace, or one never fingerprinted, has no
   * baseline, and saying so is what lets `planResume` distinguish the safe case
   * from the unexamined one.
   */
  async divergenceFor(
    session: StoredSession,
  ): Promise<DivergenceReport | null> {
    const { stores } = this.deps;
    if (session.workspaceId === null) return null;

    const workspace = stores.workspaces.get(session.workspaceId);
    if (workspace === null || workspace.lastFingerprint === null) return null;

    const kind = this.deps.runs.workspaceKind(workspace.kind);
    if (kind === null) return null;

    try {
      const now = await kind.fingerprint(workspace);
      const priorHeads = new Map(
        workspace.lastFingerprint.units.flatMap((unit) =>
          unit.head === null ? [] : [[unit.rootKey, unit.head] as const],
        ),
      );
      const ancestry = await kind.probeAncestry(workspace, priorHeads);
      return deriveDivergence(workspace.lastFingerprint, now, {
        priorHeadReachable: ancestry,
      });
    } catch (error) {
      // A workspace that cannot be read is reported as unknown divergence rather
      // than as none: "if it cannot observe something exactly, it does not claim
      // it" (principle 7), and claiming none here would let a confused
      // continuation spend money (§4.3).
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.warn(
        "could not fingerprint a workspace for divergence",
        {
          workspaceId: workspace.id,
          message,
        },
      );
      return {
        diverged: true,
        changes: [
          {
            rootKey: "*",
            kind: "unknown",
            detail: `The workspace could not be read, so what changed in it is unknown: ${message}`,
          },
        ],
        observedAt: systemMillisClock(),
      };
    }
  }

  /* ----------------------------------------------------------------- resume */

  /**
   * Resume an ended session (§6.3). Explicit by construction: there is no path
   * here from typing into a session, because `dispositionOfTypedInput` gives an
   * ended session no disposition at all until somebody names resume or fork.
   *
   * §4.3's forced-fresh gate is not optional — the divergence report is computed
   * before `planResume` is called, and a diverged workspace is refused with the
   * gate's own words.
   */
  async resume(input: {
    readonly sessionId: string;
    readonly firstTurn?: string | null;
    readonly initiationKey: string;
    readonly actor: Author;
  }): Promise<{
    readonly session: StoredSession;
    readonly firstTurnQueued: boolean;
    readonly replayed: boolean;
  }> {
    const { stores } = this.deps;
    const stored = stores.sessions.get(input.sessionId);

    // §4.1's lineage rule, which `session_resume` declares and nothing was
    // enforcing: "a session may not run, resume, or re-run itself or anything in its
    // own initiation chain." A child resuming its ancestor is principle 1 bypassed
    // with money behind it, so this is checked **first** — before the idempotency
    // lookup, because a caller that may not make the gesture at all may not retry it
    // either, and a retry is not a way to launder one.
    checkRunGesture(stores, {
      actor: input.actor,
      tool: "session_resume",
      commandIds: [],
      sessionIds: [input.sessionId],
    });

    // Idempotency is checked **before** the rules that would refuse a second
    // attempt, and the order is the point: once a resumption has happened the
    // session is running, so `planResume` would answer `already_running` — which is
    // the right answer to a *new* gesture and the wrong one to a retry of the same
    // gesture. "A retry returns the same one" (principle 9).
    const settled = stores.runs.initiation(input.initiationKey);
    if (
      settled?.settledAt != null &&
      // The kind, not only the session. A **fork**'s key settles with the id of the
      // session it created, so resuming that forked session with the fork's own key
      // matched here and answered `replayed: true` about a resumption that never
      // happened. A key names one gesture; this is the fast path reading the same
      // rule `claimInitiation` enforces, rather than a looser version of it.
      settled.kind === "resume" &&
      settled.subjectId === input.sessionId &&
      settled.sessionId === input.sessionId
    ) {
      return {
        session: stored,
        firstTurnQueued: false,
        replayed: true,
      };
    }

    const plan = planResume(stored.session, {
      resumedBy: input.actor,
      firstTurn: input.firstTurn ?? null,
      divergence: await this.divergenceFor(stored),
      at: stores.clock(),
    });

    if (!plan.ok) throw refused(plan.refusal);

    const resumed = await this.deps.runs.resumeSession({
      sessionId: input.sessionId,
      initiationKey: input.initiationKey,
      actor: input.actor,
      launch: plan.plan.launch,
    });

    // "then `firstTurn` as a normal injection if present" — the same gesture the
    // composer makes, so a resumed session's opening turn is on the graph and
    // attributed like anything else (§6.5).
    let firstTurnQueued = false;
    if (plan.plan.firstTurn !== null && !resumed.replayed) {
      await this.deps.steering.inject({
        sessionId: input.sessionId,
        text: plan.plan.firstTurn,
        actor: input.actor,
        injectionId: `inj_resume_${input.initiationKey}`,
      });
      firstTurnQueued = true;
    }

    return {
      session: stores.sessions.get(input.sessionId),
      firstTurnQueued,
      replayed: resumed.replayed,
    };
  }

  /* ------------------------------------------------------------------- fork */

  /**
   * Fork from a point (§6.3): a new session with its own workstream and workspace,
   * inheriting the conversation up to and including that turn.
   *
   * The runtime half is the contract's two lines, verbatim, and the order matters:
   * a `native` verdict calls `adapter.fork`, and **`PiForkUnavailable` is caught
   * and re-run as a seeded start** — because the adapter deliberately does not
   * substitute one for the other ("a seeded fork is not bit-identical to a native
   * one, which is the entire reason the two are distinguished"). Whichever branch
   * ran is the mode recorded, so the stored mode is never a claim nothing did.
   */
  async fork(input: {
    readonly sessionId: string;
    readonly turn: number;
    readonly initiationKey: string;
    readonly actor: Author;
  }): Promise<{
    readonly plan: SessionForkPlan;
    readonly session: StoredSession;
    readonly mode: "native" | "seeded";
    readonly replayed: boolean;
  }> {
    const { stores } = this.deps;
    const source = stores.sessions.get(input.sessionId);
    const point: TranscriptPoint = { turn: input.turn };

    // §4.1's lineage rule, which `session_fork` declares and nothing was enforcing.
    // The catalog's own resolution is "the session named by the id, and nothing
    // else. NEVER the session the fork is about to create" — so the check sees the
    // source and not the descendant it is about to make, which is what lets a
    // session fork a peer while refusing it a fork of its own ancestor.
    checkRunGesture(stores, {
      actor: input.actor,
      tool: "session_fork",
      commandIds: [],
      sessionIds: [input.sessionId],
    });

    // Null where the source ran no command: a fork spends a key and produces no
    // run of its own (§6.3), which is what migration 17 made representable.
    // The source is the subject, so a key spent forking one session is refused for
    // another — which is what the provenance edge used to be asked, indirectly and
    // wrongly: a crash between the settle and that edge made every retry refuse a
    // legitimate gesture for ever, and the edge was never drawn.
    const claim = stores.runs.claimInitiation(
      input.initiationKey,
      source.session.commandId,
      "fork",
      source.session.id,
    );
    if (claim.state === "settled") {
      // Completed rather than early-returned. The session is started and the key
      // settled inside `startForkedSession`, so a process that died between that and
      // the provenance write left a fork with no edge recording where it came from —
      // and every retry took this path and returned without drawing it. Completing
      // on every attempt is what makes the settled state whole (principle 9,
      // principle 5: there is never an invisible session, and never an unexplained
      // one either).
      return this.completeFork(
        source,
        point,
        stores.sessions.get(claim.initiation.sessionId as string),
        input.actor,
      );
    }
    if (claim.state === "in_flight") {
      throw refused({
        reason: "initiation_in_flight",
        message: `fork ${input.initiationKey} is already starting; retry once it has settled`,
      });
    }

    try {
      return await this.startFork(source, point, input);
    } catch (error) {
      // The gesture produced nothing, so the key is free again rather than
      // permanently spent on a refusal (principle 9).
      stores.runs.releaseInitiation(input.initiationKey);
      throw error;
    }
  }

  /**
   * The plan alone — what a fork *would* be, including how clean the point is.
   * A read, so the operator can see "fork-before-clean, fork-after-dirty" (§6.3)
   * before spending anything.
   */
  async planFork(
    source: StoredSession,
    point: TranscriptPoint,
    actor: Author,
    ids?: {
      readonly sessionId: SessionId;
      readonly workstreamId: WorkstreamId;
      readonly workspaceId: WorkspaceId;
    },
  ): Promise<SessionForkPlan> {
    const { stores } = this.deps;
    const { transcript } = stores.sessions.transcript(source.session.id);
    const adapter = this.deps.runs.adapterFor(source.session.runtime.adapterId);

    const forkIds = ids ?? {
      sessionId: `sess_${randomUUID()}` as SessionId,
      workstreamId: `ws_${randomUUID()}` as WorkstreamId,
      workspaceId: `wsp_${randomUUID()}` as WorkspaceId,
    };

    const result = planSessionFork(
      {
        source: source.session,
        transcript,
        capabilities: adapter.capabilities,
        // Required, and derived rather than omitted: a plan with no markers claims
        // clean with nothing examined, and the caller least likely to derive them
        // is the one that would get the most reassuring answer (§6.3).
        markers: deriveOutsideWorldMarkers(
          stores.sessions.observations(source.session.id),
          this.deps.worldDeclarations ?? NO_TOOL_WORLD_DECLARATIONS,
        ),
      },
      {
        ids: forkIds,
        point,
        forkedBy: actor,
        // The **fork's own** workstream, not the source's. A config built from the
        // source's id carries the source's workspace path, and provisioning it would
        // try to create a second checkout where one already stands — which is
        // exactly what §3.4's "workspaces never cross workstreams" is about.
        workspace: this.deps.runs.workspaceConfigFor(forkIds.workstreamId),
        workstreamName: `fork of ${source.session.id} at turn ${point.turn}`,
        subjectObjectId: (stores.workstreams.get(source.session.workstreamId)
          ?.subjectObjectId ?? null) as ObjectId | null,
        at: stores.clock(),
      },
    );

    if (!result.ok) throw refused(result.refusal);
    return result.plan;
  }

  /**
   * Finish a fork whose session already exists — a retry, or the tail of an attempt
   * that died before it drew its own provenance.
   *
   * The plan is rebuilt with the **existing** ids rather than fresh ones, so what it
   * describes is the fork that happened rather than one that would have.
   * `recordProvenance` is idempotent in the fact it states, so recording it again is
   * recording it once.
   */
  private async completeFork(
    source: StoredSession,
    point: TranscriptPoint,
    existing: StoredSession,
    actor: Author,
  ): Promise<{
    readonly plan: SessionForkPlan;
    readonly session: StoredSession;
    readonly mode: "native" | "seeded";
    readonly replayed: boolean;
  }> {
    const { stores, bus } = this.deps;

    const plan = await this.planFork(source, point, actor, {
      sessionId: existing.session.id,
      workstreamId: existing.session.workstreamId,
      workspaceId: (existing.workspaceId ??
        `wsp_${existing.session.workstreamId}`) as WorkspaceId,
    });

    const provenance = stores.graph.recordProvenance(
      stores.graph.nodeFor("session", source.session.id).id,
      stores.graph.nodeFor("session", existing.session.id).id,
      plan.provenance.relation,
    );
    bus.publish({
      entity: "edge",
      verb: "created",
      edge: toEdge(provenance),
      author: actor,
    });

    return {
      plan,
      session: existing,
      mode: stores.sessions.runtimeModeOf(existing.session.id) ?? "native",
      replayed: true,
    };
  }

  private async startFork(
    source: StoredSession,
    point: TranscriptPoint,
    input: {
      readonly sessionId: string;
      readonly initiationKey: string;
      readonly actor: Author;
    },
  ): Promise<{
    readonly plan: SessionForkPlan;
    readonly session: StoredSession;
    readonly mode: "native" | "seeded";
    readonly replayed: boolean;
  }> {
    const { stores, bus } = this.deps;
    // Ids first, so the plan, the workstream, the workspace, and the session all
    // name the same things — and a replayed gesture writes the same rows.
    const plan = await this.planFork(source, point, input.actor, {
      sessionId: `sess_${randomUUID()}` as SessionId,
      workstreamId: `ws_${randomUUID()}` as WorkstreamId,
      workspaceId: `wsp_${randomUUID()}` as WorkspaceId,
    });

    // Its own workstream and its own workspace record (§6.3, §3.4). The workspace
    // is a record, not a checkout: provisioning happens at first run, as always.
    const workstream = stores.workstreams.create({
      workstreamId: plan.workstream.id,
      author: input.actor,
      ...(plan.workstream.subjectObjectId === null
        ? {}
        : { subjectId: plan.workstream.subjectObjectId }),
    });
    bus.publish({
      entity: "workstream",
      verb: "created",
      workstream: toWorkstream(workstream),
      author: input.actor,
    });

    stores.workspaces.create({
      workspaceId: plan.workspace.id,
      workstreamId: plan.workstream.id,
      kind: plan.workspace.kind,
      config: plan.workspace.config,
      author: input.actor,
    });

    const forked = await this.deps.runs.startForkedSession({
      plan,
      sourceSessionId: source.session.id,
      initiationKey: input.initiationKey,
      actor: input.actor,
    });

    // §3.7 already has the relation; a fork records which one it is. Provenance,
    // never authored — nobody decided what the fork knows, it inherited it.
    const provenance = stores.graph.recordProvenance(
      stores.graph.nodeFor("session", source.session.id).id,
      stores.graph.nodeFor("session", forked.session.session.id).id,
      plan.provenance.relation,
    );
    bus.publish({
      entity: "edge",
      verb: "created",
      edge: toEdge(provenance),
      author: input.actor,
    });

    return {
      plan,
      session: forked.session,
      mode: forked.mode,
      replayed: false,
    };
  }

  /* ---------------------------------------------------------------- handoff */

  /**
   * Write the brief a handoff opens with (§6.3). Writing one **sends nothing**:
   * the operator reviews it, and `planHandoff` cannot be called with an unreviewed
   * brief at all — which is why this returns a draft and not a handoff.
   *
   * A brief the session never wrote can be derived from the log instead, labelled
   * as derived and paraphrasing nothing, because there is no model in `core`.
   */
  writeBrief(input: {
    readonly sessionId: string;
    readonly text?: string;
    readonly actor: Author;
    readonly briefId?: string;
  }): HandoffBrief {
    const { stores } = this.deps;
    const stored = stores.sessions.get(input.sessionId);
    const id = input.briefId ?? `brief_${randomUUID()}`;

    // No text means "derive one from the log": labelled as derived, paraphrasing
    // nothing, and authored by nobody — `Author` has no system variant, and
    // inventing one would leak an unattributed author onto the graph (§15-2).
    const drafted =
      input.text === undefined || input.text.trim().length === 0
        ? deriveHandoffBrief({
            id,
            transcript: stores.sessions.transcript(input.sessionId).transcript,
            at: stores.clock(),
          })
        : draftHandoffBrief({
            id,
            sourceSessionId: stored.session.id,
            text: input.text,
            draftedBy: input.actor,
            at: stores.clock(),
          });

    return stores.broadcasts.draft(drafted);
  }

  /**
   * The human's review (§6.3). The only producer of a brief that may be sent, and
   * it refuses a session author — so "the user edits before sending" is a property
   * of the type rather than a step somebody remembered.
   */
  reviewBrief(input: {
    readonly briefId: string;
    readonly text?: string;
    readonly actor: Author;
  }): ReviewedHandoffBrief {
    const { stores } = this.deps;
    const stored = stores.broadcasts.toBrief(
      stores.broadcasts.brief(input.briefId),
    );

    const reviewed = reviewHandoffBrief(stored, {
      ...(input.text === undefined ? {} : { text: input.text }),
      by: input.actor,
      at: stores.clock(),
    });
    if (!reviewed.ok) throw refused(reviewed.refusal);

    return stores.broadcasts.review(reviewed.value);
  }

  /**
   * Send a reviewed brief (§6.3): it seeds a new session and stays on the graph as
   * content, authored by the reviewer — "the human decided this session should know
   * this", which is exactly what §15-2 records.
   */
  async handoff(input: {
    readonly briefId: string;
    readonly workstreamId: string;
    readonly initiationKey: string;
    readonly actor: Author;
  }): Promise<{
    readonly session: StoredSession;
    readonly briefNodeId: string;
    readonly replayed: boolean;
  }> {
    const { stores, bus } = this.deps;

    // `session_handoff` is declared `humanOnly`, and a flag describes while a gate
    // refuses. Sending is the operator's act by the same reasoning the review step
    // is: the brief exists because a human decided this work should move, and a
    // session sending its own brief is that decision not being made (§6.3).
    if (input.actor.kind !== "human") {
      throw refused({
        reason: "human_only",
        message:
          "a handoff is sent by the user: the brief is reviewed and sent by whoever decided the work should move, and a session sending its own is that decision not happening (§6.3)",
      });
    }

    const row = stores.broadcasts.brief(input.briefId);
    const brief = stores.broadcasts.toBrief(row);

    if (brief.state !== "reviewed") {
      // The type would refuse this anyway; the endpoint says so in words, because
      // "review it first" is actionable and a type error is not, over HTTP.
      throw refused({
        reason: "brief_not_reviewed",
        message:
          "this brief has not been reviewed; the user edits a handoff brief before it is sent (§6.3)",
      });
    }
    // "Already sent" and "sent by this very gesture" are different facts, and the
    // order below is what tells them apart. A brief may be sent once — a second
    // handoff of the same brief would seed a second session from one decision — but a
    // **retry of the gesture that sent it** must answer with what that gesture
    // produced, exactly as inject, resume, and fork do (principle 9). Checking
    // `sentAt` first refused the retry, which is how the crash window below became
    // unrecoverable: the retry could never reach the writes it needed to complete.
    const spent = stores.runs.initiation(input.initiationKey);
    const settled = spent?.settledAt != null && spent.sessionId !== null;

    // A settled key names its **whole** gesture, and the brief is part of it.
    //
    // Without this, replaying brief A's key while sending brief B took the retry
    // path with B's plan: B's content and edge were wired into A's session,
    // provenance was recorded from B's source to A's session, and B was marked sent
    // — permanently, so B could never seed a session of its own. Nothing refused and
    // nothing said so, which is the worst shape a bug can have.
    if (settled && spent?.subjectId !== input.briefId) {
      throw refused({
        reason: "initiation_key_reused",
        message: `initiation key ${input.initiationKey} already sent brief ${String(spent?.subjectId)}; a different brief is a different handoff and needs its own key (principle 9)`,
      });
    }

    const isRetry = settled;

    if (!isRetry && row.sentAt !== null) {
      throw refused({
        reason: "already_sent",
        message: `brief ${input.briefId} was already sent; draft a new one to hand off again (principle 9)`,
      });
    }

    const source = stores.sessions.get(brief.sourceSessionId);
    const started = await this.deps.runs.startHandoffSession({
      brief,
      workstreamId: input.workstreamId,
      launch: source.session.launch,
      initiationKey: input.initiationKey,
      actor: input.actor,
    });

    const targetNode = stores.graph.nodeFor(
      "session",
      started.session.session.id,
    );
    const plan = planHandoff(brief, {
      ids: {
        sessionId: started.session.session.id,
        objectId: `obj_brief_${brief.id}` as ObjectId,
        nodeId: `node_brief_${brief.id}` as NodeId,
        edgeId: `edge_brief_${brief.id}` as EdgeId,
      },
      workstreamId: input.workstreamId as WorkstreamId,
      targetNodeId: targetNode.id as NodeId,
      launch: source.session.launch,
      ordinal: stores.graph.contextInputs(targetNode.id).length + 1,
      at: stores.clock(),
    });

    // Unconditionally, replay or not, and every write below is idempotent in an id
    // the plan supplied.
    //
    // These used to run only on the first attempt, which left a crash window with
    // teeth: the session is started and its key settled inside
    // `startHandoffSession`, so a process that died between that and here made every
    // retry take the replay path and skip the brief's graph writes and `markSent`
    // **permanently** — a handoff whose brief was never wired into the session it
    // seeded, and a brief still marked unsent and therefore re-sendable. Completing
    // them on every attempt is what makes the settled state whole rather than
    // hoping the two halves never come apart (principle 9, principle 12).
    {
      const written = stores.objects.write({
        objectId: plan.content.objectId,
        kind: plan.content.kind,
        title: plan.content.title,
        renderings: {
          card: { text: plan.content.title },
          summary: plan.content.title,
          agentContent: plan.content.body,
        },
        workstreamId: input.workstreamId,
      });
      const object = stores.objects.get(written.objectId);
      if (object !== undefined) {
        bus.publish({
          entity: "object",
          verb: "created",
          object: toPlotObject(object),
          author: input.actor,
        });
      }

      const node = stores.graph.place({
        nodeId: plan.content.nodeId,
        role: "content",
        refId: written.objectId,
        workstreamId: input.workstreamId,
      });
      bus.publish({
        entity: "node",
        verb: "created",
        node: toPlacedNode(node),
        author: input.actor,
      });

      const edge = stores.graph.addContextEdge({
        edgeId: plan.edge.id,
        from: plan.content.nodeId,
        to: plan.edge.to,
        // The reviewer, not the drafting session: the human decided this session
        // should know this (§15-2).
        author: plan.edge.author,
        ordinal: plan.edge.ordinal,
      });
      bus.publish({
        entity: "edge",
        verb: "created",
        edge: toEdge(edge),
        author: input.actor,
      });

      const provenance = stores.graph.recordProvenance(
        stores.graph.nodeFor("session", brief.sourceSessionId).id,
        targetNode.id,
        plan.provenance.relation,
      );
      bus.publish({
        entity: "edge",
        verb: "created",
        edge: toEdge(provenance),
        author: input.actor,
      });

      // Last, so a crash before it leaves the brief re-sendable rather than sent
      // with nothing to show for it: the graph writes above are the handoff, and
      // this is the record that it happened.
      stores.broadcasts.markSent(brief.id, stores.clock());
    }

    return {
      session: started.session,
      briefNodeId: plan.content.nodeId,
      replayed: started.replayed,
    };
  }

  /* ------------------------------------------------------- continue vs fresh */

  /**
   * §4.3's decision, side by side, for one command: what continuing sends against
   * what a fresh run sends, with each option's own gates and the reason a refused
   * one is refused.
   *
   * Both required inputs are real here rather than defaulted: the window fit is
   * measured against the command's declared model window, and the divergence is
   * the workspace's actual state — "a preview that skipped it is exactly the one
   * that spends money on a confused continuation".
   */
  async continueVsFresh(commandId: string): Promise<ContinueVsFresh> {
    const { stores } = this.deps;
    const command = stores.commands.command(commandId);
    const definition = stores.commands.definition(command.definitionId);
    const preview = stores.runs.preview(commandId);

    // The newest session this command ran, which is what "continue" would continue.
    const prior = stores.sessions
      .list({ includeDeleted: true })
      .filter((stored) => stored.session.commandId === commandId)
      .at(-1);

    const priorTranscript =
      prior === undefined
        ? null
        : stores.sessions.transcript(prior.session.id).transcript;

    return compareContinueVsFresh({
      priorSession:
        prior === undefined
          ? null
          : {
              sessionId: prior.session.id,
              running: prior.session.end === null,
              deleted: prior.session.deletion.deletedAt !== null,
              // Bringing its whole history back is what continuing a completed
              // session costs (§4.3), estimated from the transcript it would carry.
              historyTokens: estimateTokensOf(priorTranscript),
            },
      assemblyTokens: preview.estimatedTokens,
      // What changed since, delivered as a new turn: the drifted inputs are what a
      // continuation would have to be told about.
      changedSinceTokens: preview.estimatedTokens,
      windowTokens: definition.budget.modelWindowTokens,
      divergence: prior === undefined ? null : await this.divergenceFor(prior),
      priorRuns: stores.runs.pricedHistory(definition.id),
      // The command's declared default (§4.3). Definitions do not carry one yet —
      // the field is Epic 6.4's, and until it exists the shipped default stands and
      // says so rather than being guessed per command.
      defaultMode: DEFAULT_CONTINUATION_MODE,
    });
  }

  /** Questions this session asked, for a surface that shows them beside a resume. */
  questionsFor(sessionId: string): readonly SessionQuestion[] {
    return this.deps.stores.questions.forSession(sessionId);
  }
}

/**
 * Roughly what a transcript would cost to replay. The same four-characters-a-token
 * estimate assembly uses, applied to the rendered transcript — an estimate, and
 * `ContinuationComparison` says so: its basis is input tokens, never money.
 */
function estimateTokensOf(
  transcript: { readonly turns: readonly unknown[] } | null,
): number {
  if (transcript === null) return 0;
  return Math.ceil(JSON.stringify(transcript).length / 4);
}

/** Refusals that are this service's own rather than a planner's. */
export function requireTurn(turn: unknown): number {
  if (typeof turn !== "number" || !Number.isInteger(turn) || turn < 1) {
    throw badRequest("a fork names the 1-based transcript turn to fork at");
  }
  return turn;
}
