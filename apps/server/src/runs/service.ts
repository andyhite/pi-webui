import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  checkReady,
  classifyEnd,
  readinessProvisionFailed,
  readinessProvisioned,
  readinessProvisioning,
  readinessSetupFinished,
  readinessSetupStarted,
  resolveSetup,
  exportTranscript,
  PiForkUnavailable,
  systemMillisClock,
  transcriptPrefix,
  transcriptRenderings,
  type Author,
  type BudgetScope,
  type CompletionEvidence,
  type CompletionProof,
  type EffectiveBudget,
  type ConditionEvaluation,
  type Run,
  type RunCost,
  type RuntimeRequest,
  type RuntimeRequestId,
  type RuntimeSessionHandle,
  type SessionEnd,
  type SessionForkPlan,
  type SessionId,
  type SessionLaunchChoices,
  type SessionRuntimeAdapter,
  type SessionStatus,
  type Workspace,
  type WorkspaceKind,
  type WorkspaceKindConfig,
  type WorkspaceKindRegistry,
  type WorkstreamId,
} from "@plotroom/core";
import type { RunPreview, RunRefusal, StoredSession } from "@plotroom/db";
import type { ServerConfig } from "../config.js";
import type { ConditionCheckRegistry } from "../conditions/registry.js";
import type { EventBus } from "../events/bus.js";
import { refused } from "../http/errors.js";
import type { Logger } from "../logging/logger.js";
import type { RuntimeRegistry } from "../runtime/registry.js";
import type { RuntimeScript } from "../runtime/scripted.js";
import { driveSession } from "../sessions/driver.js";
import type { SessionHub } from "../sessions/hub.js";
import type { ApiStores } from "../routes/api.js";
import { toCommandNode, toEdge, toPlacedNode } from "../routes/mappers.js";
import type { BudgetService } from "../budgets/service.js";
import type { ClaimService } from "../claims/service.js";
import type { SessionGate } from "../sessions/gate.js";
import {
  attributionChain,
  checkDelegation,
  recordDelegation,
} from "./delegation.js";

/**
 * Run one command (spec §4.1, §3.5) — the gesture the whole product exists for.
 *
 * The order below is the spec's, and each step is a refusal rather than a
 * degradation when it cannot be taken:
 *
 *   1. the initiation key is claimed, so a retry is the same gesture, not a
 *      second one (principle 9);
 *   2. the workspace is provisioned **at first run** and its readiness gate is
 *      the thing that blocks, with the reason visible (§3.4);
 *   3. the ordered context is assembled whole, warned about when it approaches
 *      the model's window, and refused over an opt-in hard cap — never
 *      truncated (§3.5, principle 12);
 *   4. the run is recorded with the exact assembled content, the versions that
 *      went in, and the configuration it ran under (§15-1), addressable as
 *      `output@n` (§15-4);
 *   5. the session starts under the workstream, and everything after that is
 *      derived from its observation log.
 *
 * Completion is the second half: a submission is checked against the declared
 * world conditions, a failure comes back as feedback and the session continues,
 * and only proof ends it as completed (§3.5, principle 3).
 */
export interface RunOneInput {
  readonly commandId: string;
  /** Client-supplied; the same key is the same gesture (principle 9). */
  readonly initiationKey: string;
  readonly actor: Author;
  /**
   * Which runtime, and (scripted only) the script it replays. Optional and
   * undefined-tolerant on purpose: the configured runtime is the answer when a
   * caller does not name one.
   */
  readonly runtime?: {
    readonly adapterId?: string | undefined;
    readonly script?: RuntimeScript | undefined;
  };
  /**
   * The cap accepted at the preview (§4.1, §8). Recorded on the run so what was
   * agreed can be compared with what it cost; Phase 6 enforces it.
   */
  readonly spendCapMicros?: number | null | undefined;
}

/** What the preview endpoint answers with (§4.1). */
export interface RunPreviewResult {
  readonly preview: RunPreview;
  readonly workspace: {
    readonly state: string;
    /** True when running this will provision a workspace first (§3.4). */
    readonly provisionsAtFirstRun: boolean;
    readonly reason: string | null;
    /** False when nothing is configured to provision from — a run would refuse. */
    readonly configured: boolean;
  };
  readonly spendCap: {
    readonly suggestedMicros: number | null;
    readonly basis: string;
    /** Always null here: accepting one is the run request's business. */
    readonly accepted: number | null;
  };
  /** What already binds this work, whatever cap is accepted (§8). */
  readonly budget: EffectiveBudget;
}

export interface RunOneResult {
  readonly run: Run;
  readonly session: StoredSession;
  readonly status: SessionStatus;
  /** Present when assembly approached the model's window (§3.5). */
  readonly warning: string | null;
  /** True when the initiation key had already produced this run and session. */
  readonly replayed: boolean;
}

export interface StopSessionInput {
  readonly sessionId: string;
  readonly mode: "graceful" | "hard";
  /**
   * Why it is stopping. `budget` is Phase 6's enforcer calling through the same
   * vocabulary, and it is a distinct end state: out-of-budget is not failure and
   * not an ordinary stop (§3.6, §8).
   */
  readonly cause: "user" | "budget";
  readonly scope?: BudgetScope;
}

/** What a graceful close waits for before the database is closed. */
const SHUTDOWN_DRAIN_MS = 2_000;

/**
 * The window a session with no command definition behind it is metered against —
 * a handoff, or a fork whose source's definition is gone. Labelled `estimated` by
 * the accounting fold either way, so it is a scale rather than a claim.
 */
const DEFAULT_HANDOFF_WINDOW_TOKENS = 200_000;

/**
 * How long a resume waits for the previous handle's pump to finish before letting
 * go of it. Bounded for the same reason the shutdown drain is: a runtime that will
 * not end its stream must not hold a gesture open for ever (principle 11).
 */
const RESUME_DRAIN_MS = 2_000;

export interface RestartRecovery {
  /** Sessions that were in flight when the last process died (principle 11). */
  readonly interrupted: readonly StoredSession[];
  /** Initiation keys no attempt could still hold (principle 9). */
  readonly freedInitiationKeys: readonly string[];
}

export interface RunServiceDeps {
  readonly config: ServerConfig;
  readonly stores: ApiStores;
  readonly bus: EventBus;
  readonly logger: Logger;
  readonly runtimes: RuntimeRegistry;
  readonly workspaceKinds: WorkspaceKindRegistry;
  readonly conditions: ConditionCheckRegistry;
  readonly hub: SessionHub;
  /** Path claims (§3.4): granted at provisioning, released when a session ends. */
  readonly claims: ClaimService;
  /** Where a session's writes meet its claims, per call (§3.4, C6). */
  readonly gate: SessionGate;
  /**
   * Budgets (§8). Which caps bind a session and what remains of them; the run path
   * is what acts on the answer, because ending a session is its verb.
   */
  readonly budgets: BudgetService;
}

export class RunService {
  /**
   * What to do with a runtime-raised question (§6.4). Set by the app after the
   * steering service exists; a question raised before anything registered is
   * logged rather than dropped silently, because a question nobody sees is the
   * invisible stall §6.4 exists to prevent.
   */
  #onQuestion:
    | ((input: {
        readonly sessionId: string;
        readonly requestId: RuntimeRequestId;
        readonly request: Extract<RuntimeRequest, { kind: "question" }>;
      }) => void)
    | null = null;

  constructor(private readonly deps: RunServiceDeps) {}

  /** Register the question sink. One registration; the last one wins. */
  onQuestion(
    sink: (input: {
      readonly sessionId: string;
      readonly requestId: RuntimeRequestId;
      readonly request: Extract<RuntimeRequest, { kind: "question" }>;
    }) => void,
  ): void {
    this.#onQuestion = sink;
  }

  /* -------------------------------------------------------------- preview */

  /**
   * The run preview (§4.1): "exactly what will execute, what it is likely to
   * cost, and the spend cap it will run under — before anything starts".
   *
   * It is a **read**. It provisions no workspace, starts no runtime, and records
   * nothing: the whole value of a preview is that looking is free, and a preview
   * with a side effect is a run with extra steps. The workspace half is
   * therefore reported from the record — what state it is in, and whether the
   * first run will have to provision one — rather than by touching a mechanism.
   */
  preview(
    commandId: string,
    actor: Author = { kind: "human" },
  ): RunPreviewResult {
    const { stores, config } = this.deps;
    const planned = stores.runs.preview(commandId);
    const command = stores.commands.command(commandId);
    const workspace = stores.workspaces.forWorkstream(command.workstreamId);

    // An exhausted budget is a blocker on the plan, not a footnote beside it: a
    // preview that said "ready" while the run refused for want of money would be
    // the one thing this preview exists not to do (§4.1). Collected here rather
    // than in the store because a budget is a property of the workstream and the
    // caller, which a command-scoped plan cannot see.
    const budgetBlocker = this.budgetBlocker(command.workstreamId, actor);
    const preview = {
      ...planned,
      blockers:
        budgetBlocker === null
          ? planned.blockers
          : [...planned.blockers, budgetBlocker],
      runnable: planned.runnable && budgetBlocker === null,
    };

    const readiness =
      workspace === null
        ? {
            state: "unprovisioned" as const,
            provisionsAtFirstRun: true,
            reason:
              "no workspace yet; the first run provisions one, which takes time and disk (§3.4)",
            configured:
              config.workspace.repositoryPath !== null ||
              config.workspace.remoteUrl !== null,
          }
        : {
            state: workspace.readiness.state,
            provisionsAtFirstRun: workspace.provisionedAt === null,
            reason: readinessReason(workspace),
            configured: true,
          };

    return {
      preview,
      workspace: readiness,
      // What the operator is being asked to accept. The suggestion is the most
      // expensive prior run, because a cap under that is a cap this command has
      // already exceeded once — and there is deliberately no suggestion at all
      // when nothing has ever been priced (§4.1: no bare numbers).
      spendCap: {
        suggestedMicros: preview.estimate.range?.highMicros ?? null,
        basis: preview.estimate.basis,
        accepted: null,
      },
      // What already binds this work before a cap is accepted (§8), so the
      // operator sees what the run will be measured against rather than only what
      // it might cost.
      budget:
        actor.kind === "session"
          ? this.deps.budgets.forSession(actor.sessionId)
          : this.deps.budgets.forWorkstream(command.workstreamId),
    };
  }

  /* --------------------------------------------------------------- run one */

  async runOne(input: RunOneInput): Promise<RunOneResult> {
    const { stores } = this.deps;
    const claim = stores.runs.claimInitiation(
      input.initiationKey,
      input.commandId,
    );

    if (claim.state === "settled") {
      const run = stores.runs.run(claim.initiation.runId as string);
      const session = stores.sessions.get(claim.initiation.sessionId as string);
      return {
        run,
        session,
        status: this.statusOf(session.session.id),
        // The same gesture gets the same answer, warning included: it is
        // recomputed from what the run recorded (§15-1), so a retry cannot lose
        // the fact that assembly was near the model's window — which is the
        // whole point of warning about it.
        warning: stores.runs.assemblyWarning(run.id),
        replayed: true,
      };
    }

    if (claim.state === "in_flight") {
      throw refused({
        reason: "initiation_in_flight",
        message: `initiation ${input.initiationKey} is already starting; retry once it has settled`,
      });
    }

    try {
      return await this.start(input);
    } catch (error) {
      // The gesture produced nothing, so the key is free again rather than
      // permanently spent on a refusal.
      stores.runs.releaseInitiation(input.initiationKey);
      throw error;
    }
  }

  private async start(input: RunOneInput): Promise<RunOneResult> {
    const { stores, bus, config } = this.deps;
    const command = stores.commands.command(input.commandId);
    const definition = stores.commands.definition(command.definitionId);

    // §4.1's lineage rule, first, before anything is recorded: "a session cannot
    // run, resume, or re-run itself or anything in its own initiation chain." A
    // human actor passes through untouched — they are the authority the chain
    // terminates at (principle 1).
    checkDelegation(stores, { actor: input.actor, commandId: input.commandId });

    // §8's cap, enforced before anything is provisioned or recorded: a run with no
    // money to spend is refused with the reason, never started and immediately
    // stopped — that would leave history claiming an attempt nothing happened in.
    const budgetBlocker = this.budgetBlocker(command.workstreamId, input.actor);
    if (budgetBlocker !== null) throw refused(budgetBlocker);

    // Workspaces are provisioned at first run, and readiness is what blocks
    // (§3.4). Before this line nothing has been recorded, so a not-ready
    // workspace refuses the gesture instead of leaving half a run behind.
    const workspace = await this.ensureWorkspace(
      command.workstreamId,
      input.actor,
    );
    const workspacePath = workspace.roots[0]?.path;
    if (workspacePath === undefined) {
      throw refused({
        reason: "workspace_no_root",
        message: "the workspace reported no root to work in",
      });
    }

    const started = stores.runs.start({
      commandId: input.commandId,
      ...(input.spendCapMicros === undefined
        ? {}
        : { spendCapMicros: input.spendCapMicros }),
    });
    const assembled = stores.runs.assembledContent(started.run.id);

    const launch = {
      model: definition.model.model,
      effort: definition.model.effort,
      // §3.5's declared allow list is a narrowing of the app's tools, and an
      // empty list honestly means "no tools" rather than "all of them".
      toolPermissions: { allowedTools: definition.permissions.allowed },
    };

    let handle;
    let adapterId: string;
    try {
      const launched = await this.deps.runtimes.start(
        input.runtime?.adapterId ?? config.runtime.adapterId,
        {
          config: { prompt: assembled, launch, workspacePath },
          ...(input.runtime?.script === undefined
            ? {}
            : { script: input.runtime.script }),
        },
      );
      handle = launched.handle;
      adapterId = launched.adapter.id;
    } catch (error) {
      // The run exists and §15-1 already recorded what it would have run with;
      // it ends as a failure that says why, rather than staying "running".
      const message = error instanceof Error ? error.message : String(error);
      stores.runs.fail(
        started.run.id,
        `the runtime would not start: ${message}`,
      );
      this.publishRun(stores.runs.run(started.run.id), input.actor);
      throw error;
    }

    const session = stores.sessions.start({
      workstreamId: command.workstreamId,
      commandId: command.id,
      runId: started.run.id,
      workspaceId: workspace.id,
      mode: definition.lifecycle === "producing" ? "producing" : "open",
      launch,
      initiatedBy: input.actor,
      runtime: { adapterId, ref: handle.ref },
    });

    // The session goes on the board, and the command that started it is
    // recorded as provenance — never authored (§3.7).
    const node = stores.graph.place({
      role: "session",
      refId: session.session.id,
      workstreamId: command.workstreamId,
      running: true,
    });
    const provenance = stores.graph.recordProvenance(
      stores.commands.commandNode(command.id).id,
      node.id,
      "command_started_session",
    );

    stores.runs.settleInitiation(
      input.initiationKey,
      started.run.id,
      session.session.id,
    );

    // A session actor makes this run a delegation (§3.6): the child is on the
    // graph with its provenance, "never hidden inside a tool call", and its spend
    // is attributed up the chain that initiated it (principle 2).
    if (input.actor.kind === "session") {
      const delegation = recordDelegation(stores, {
        parent: input.actor.sessionId,
        childSessionId: session.session.id,
        workstreamId: command.workstreamId,
        commandId: command.id,
        reason: `delegated run of ${definition.name}`,
      });
      bus.publish({
        entity: "edge",
        verb: "created",
        edge: toEdge(stores.graph.edge(delegation.edgeId)),
        author: input.actor,
      });
      this.deps.logger.info("a session delegated a run", {
        parentSessionId: input.actor.sessionId,
        childSessionId: session.session.id,
        attributionChain: delegation.plan.attributionChain,
      });
    }

    // §3.4's single-writer default, at the moment a workspace first has work in
    // it: "a workstream begins with one session holding the **root claim**, and
    // every claim is a subdivision of a claim someone already holds". The grant
    // is the operator's, which is what makes principle 1 hold — every claim
    // downstream subdivides a human's reach and no chain acquires any. A second
    // session in the same workstream gets nothing here: it asks.
    const rootClaim = this.deps.claims.grantRootClaim(
      command.workstreamId,
      session.session.id,
    );
    if (rootClaim === null) {
      this.deps.logger.info(
        "the workstream already has a writer; this session claims per path",
        { workstreamId: command.workstreamId, sessionId: session.session.id },
      );
    }

    this.publishRun(started.run, input.actor, "created");
    bus.publish({
      entity: "command",
      verb: "updated",
      command: toCommandNode(command),
      author: input.actor,
    });
    bus.publish({
      entity: "node",
      verb: "created",
      node: toPlacedNode(node),
      author: input.actor,
    });
    bus.publish({
      entity: "edge",
      verb: "created",
      edge: toEdge(provenance),
      author: input.actor,
    });

    const status = this.statusOf(session.session.id);
    bus.publish({
      entity: "session",
      verb: "created",
      session: session.session,
      status,
      author: input.actor,
    });

    this.attach(
      session.session.id,
      handle,
      adapterId,
      definition.budget.modelWindowTokens,
    );

    return {
      run: started.run,
      session,
      status,
      warning: started.warning,
      replayed: false,
    };
  }

  /* -------------------------------------------- what continuation needs (§6.3) */

  /**
   * The workspace kind for a workspace record, or null when the installation has
   * none registered under that name.
   *
   * Null rather than a throw: divergence detection asks this, and "the mechanism is
   * not available" is a reason to report unknown divergence rather than to fail the
   * request that asked (principle 7).
   */
  workspaceKind(kind: string): WorkspaceKind | null {
    const lookup = this.deps.workspaceKinds.require(kind);
    return lookup.available ? lookup.kind : null;
  }

  /** The adapter a session is bound to — its capabilities decide how a fork works. */
  adapterFor(adapterId: string): SessionRuntimeAdapter {
    return this.deps.runtimes.require(adapterId);
  }

  /** The workspace configuration a fork's own workspace inherits (§3.4). */
  workspaceConfigFor(workstreamId: string): {
    readonly kind: string;
    readonly config: WorkspaceKindConfig;
  } {
    return {
      kind: this.deps.config.workspace.kind,
      config: this.workspaceConfig(workstreamId),
    };
  }

  /**
   * Resume an ended session (§6.3): the **same record** continues, which is the
   * whole difference from a fork. The runtime is reopened at its persisted native
   * ref — "persisted for exactly this" (§3.6) — and the observation pump is
   * re-attached, so everything downstream is derived exactly as it was before.
   *
   * Idempotent in the initiation key: one gesture, one resumption (principle 9).
   */
  async resumeSession(input: {
    readonly sessionId: string;
    readonly initiationKey: string;
    readonly actor: Author;
    readonly launch: SessionLaunchChoices;
  }): Promise<{ readonly session: StoredSession; readonly replayed: boolean }> {
    const { stores } = this.deps;
    const stored = stores.sessions.get(input.sessionId);

    const live = this.deps.hub.get(input.sessionId);
    if (live !== null) {
      // Already live and attached: the gesture has nothing to do, which is not the
      // same as it having failed.
      if (stored.session.end === null) {
        return { session: stored, replayed: true };
      }

      // Ended record, handle still draining. The previous pump has an end still to
      // record — a stop writes the outcome before it touches the runtime, so the
      // `session-ended` observation is always behind it — and a record reopened
      // underneath it would inherit that end and report a running session as
      // finished. So the old pump is let finish and let go of *before* anything is
      // reopened. Bounded, because a runtime that will not end its stream must not
      // hold a resume open for ever (principle 11).
      await Promise.race([
        live.pump,
        new Promise((resolve) => setTimeout(resolve, RESUME_DRAIN_MS).unref()),
      ]);
      await live.handle.stop("abort").catch(() => undefined);
      this.deps.hub.detach(input.sessionId);
    }

    // Null where the session ran no command: a resume spends a key and produces no
    // run (§6.3), which migration 17 made representable rather than smuggled. The
    // kind is compared too, so a key already spent on a run or a fork is refused
    // rather than answered as if it were this resumption.
    const claim = stores.runs.claimInitiation(
      input.initiationKey,
      stored.session.commandId,
      "resume",
      // The session being resumed is the subject, so a key spent resuming one is
      // refused for another rather than answering about the wrong session.
      input.sessionId,
    );
    if (claim.state === "settled") {
      // A settled key answers with **what it produced**, not with what this call
      // asked about. Returning the input session on any settled key would let one
      // key report a resumption of a session it never touched — a retry that says
      // "already done" about the wrong thing is worse than a refusal.
      if (claim.initiation.sessionId !== input.sessionId) {
        throw refused({
          reason: "initiation_key_reused",
          message: `initiation key ${input.initiationKey} already resumed session ${String(claim.initiation.sessionId)}; use a new key for a different session (principle 9)`,
        });
      }
      return { session: stores.sessions.get(input.sessionId), replayed: true };
    }
    if (claim.state === "in_flight") {
      throw refused({
        reason: "initiation_in_flight",
        message: `resumption ${input.initiationKey} is already starting; retry once it has settled`,
      });
    }

    try {
      const workspace = await this.ensureWorkspace(
        stored.session.workstreamId,
        input.actor,
      );
      const workspacePath = workspace.roots[0]?.path;
      if (workspacePath === undefined) {
        throw refused({
          reason: "workspace_no_root",
          message: "the workspace reported no root to work in",
        });
      }

      const adapter = this.adapterFor(stored.session.runtime.adapterId);
      const handle = await adapter.resume(stored.session.runtime.ref, {
        launch: input.launch,
        workspacePath,
      });

      // The end is cleared: a resumed session is live again, and a record that kept
      // its end state would report a session that is running as finished (§3.6).
      const reopened = stores.sessions.reopen(input.sessionId);

      // And its node goes back to running, which is not cosmetic: §3.7 only lets
      // content wire into a *running* session, so a resumed session whose node still
      // said otherwise would refuse the very first turn the resume delivers.
      const node = stores.graph.nodeFor("session", input.sessionId);
      stores.graph.setRunning(node.id, true);
      this.deps.bus.publish({
        entity: "node",
        verb: "updated",
        node: toPlacedNode(stores.graph.node(node.id)),
        author: input.actor,
      });
      stores.runs.settleInitiation(
        input.initiationKey,
        stored.runId ?? null,
        input.sessionId,
      );

      this.attach(
        input.sessionId,
        handle,
        adapter.id,
        this.modelWindowFor(stored),
      );
      this.publishSession(reopened, input.actor);

      return { session: reopened, replayed: false };
    } catch (error) {
      stores.runs.releaseInitiation(input.initiationKey);
      throw error;
    }
  }

  /**
   * Start the session a fork plans (§6.3).
   *
   * **The contract's two lines, verbatim, and the order is the point.** A `native`
   * verdict calls `adapter.fork`; `PiForkUnavailable` is caught here and re-run as
   * `start({ seedTranscript })`, because the adapter deliberately does not
   * substitute one for the other — "a seeded fork is not bit-identical to a native
   * one, which is the entire reason the two are distinguished". A `seeded` verdict
   * seeds directly. Whichever branch ran is the mode recorded, so the stored mode
   * is never a claim nothing did.
   */
  async startForkedSession(input: {
    readonly plan: SessionForkPlan;
    readonly sourceSessionId: string;
    readonly initiationKey: string;
    readonly actor: Author;
  }): Promise<{
    readonly session: StoredSession;
    readonly mode: "native" | "seeded";
  }> {
    const { stores } = this.deps;
    const plan = input.plan;
    const source = stores.sessions.get(input.sourceSessionId);

    const workspace = await this.ensureWorkspace(
      plan.session.workstreamId,
      input.actor,
    );
    const workspacePath = workspace.roots[0]?.path;
    if (workspacePath === undefined) {
      throw refused({
        reason: "workspace_no_root",
        message: "the fork's workspace reported no root to work in",
      });
    }

    const adapter = this.adapterFor(source.session.runtime.adapterId);
    const config = {
      prompt: "",
      launch: plan.session.launch,
      workspacePath,
    };

    let handle;
    let mode: "native" | "seeded";

    if (plan.runtime.mode === "native") {
      try {
        handle = await adapter.fork(
          source.session.runtime.ref,
          plan.point,
          config,
        );
        mode = "native";
      } catch (error) {
        if (!(error instanceof PiForkUnavailable)) throw error;
        // The seeded branch is the caller's, and this is the caller. The prefix is
        // what a fresh session is started from, and the mode recorded is the one
        // that actually happened.
        this.deps.logger.info(
          "a native fork was unavailable; seeding instead",
          {
            sourceSessionId: input.sourceSessionId,
            turn: plan.point.turn,
            reason: error.message,
          },
        );
        handle = await adapter.start({
          ...config,
          seedTranscript: seedFrom(this.deps.stores, source, plan),
        });
        mode = "seeded";
      }
    } else {
      handle = await adapter.start({
        ...config,
        seedTranscript: plan.runtime.seed,
      });
      mode = "seeded";
    }

    const session = stores.sessions.start({
      sessionId: plan.session.id,
      workstreamId: plan.session.workstreamId,
      workspaceId: workspace.id,
      mode: plan.session.mode,
      launch: plan.session.launch,
      initiatedBy: plan.session.initiatedBy,
      runtime: { adapterId: adapter.id, ref: handle.ref },
      runtimeMode: mode,
    });

    const node = stores.graph.place({
      role: "session",
      refId: session.session.id,
      workstreamId: plan.session.workstreamId,
      running: true,
    });
    this.deps.bus.publish({
      entity: "node",
      verb: "created",
      node: toPlacedNode(node),
      author: input.actor,
    });

    stores.runs.settleInitiation(input.initiationKey, null, session.session.id);

    this.publishSession(session, input.actor);
    this.attach(
      session.session.id,
      handle,
      adapter.id,
      this.modelWindowFor(source),
    );

    return { session, mode };
  }

  /**
   * Start the session a handoff seeds (§6.3). An ordinary start — the brief reaches
   * it as content wired in by the reviewer, which is the gesture, not a runtime
   * feature.
   */
  async startHandoffSession(input: {
    readonly brief: {
      readonly id: string;
      readonly text: string;
      readonly sourceSessionId: string;
    };
    readonly workstreamId: string;
    readonly launch: SessionLaunchChoices;
    readonly initiationKey: string;
    readonly actor: Author;
  }): Promise<{
    readonly session: StoredSession;
    readonly replayed: boolean;
  }> {
    const { stores } = this.deps;

    const claim = stores.runs.claimInitiation(
      input.initiationKey,
      null,
      "handoff",
      // The brief is the subject. Without it a key spent sending one brief answered
      // as a retry while a *different* brief's writes went into the first one's
      // session — a corruption rather than a refusal.
      input.brief.id,
    );
    if (claim.state === "settled") {
      return {
        session: stores.sessions.get(claim.initiation.sessionId as string),
        replayed: true,
      };
    }
    if (claim.state === "in_flight") {
      throw refused({
        reason: "initiation_in_flight",
        message: `handoff ${input.initiationKey} is already starting; retry once it has settled`,
      });
    }

    try {
      const workspace = await this.ensureWorkspace(
        input.workstreamId,
        input.actor,
      );
      const workspacePath = workspace.roots[0]?.path;
      if (workspacePath === undefined) {
        throw refused({
          reason: "workspace_no_root",
          message: "the workspace reported no root to work in",
        });
      }

      const adapter = this.deps.runtimes.require(
        this.deps.config.runtime.adapterId,
      );
      const handle = await adapter.start({
        prompt: input.brief.text,
        launch: input.launch,
        workspacePath,
      });

      const session = stores.sessions.start({
        workstreamId: input.workstreamId,
        workspaceId: workspace.id,
        // Open: a handoff opens a conversation, and the receiving session's own
        // outcome is whatever it is later given to produce (§3.5).
        mode: "open",
        launch: input.launch,
        initiatedBy: input.actor,
        runtime: { adapterId: adapter.id, ref: handle.ref },
      });

      const node = stores.graph.place({
        role: "session",
        refId: session.session.id,
        workstreamId: input.workstreamId,
        running: true,
      });
      this.deps.bus.publish({
        entity: "node",
        verb: "created",
        node: toPlacedNode(node),
        author: input.actor,
      });

      stores.runs.settleInitiation(
        input.initiationKey,
        null,
        session.session.id,
      );
      this.publishSession(session, input.actor);
      this.attach(
        session.session.id,
        handle,
        adapter.id,
        DEFAULT_HANDOFF_WINDOW_TOKENS,
      );

      return { session, replayed: false };
    } catch (error) {
      stores.runs.releaseInitiation(input.initiationKey);
      throw error;
    }
  }

  /** The model window a session's accounting meter is measured against. */
  private modelWindowFor(stored: StoredSession): number {
    if (stored.session.commandId === null) return DEFAULT_HANDOFF_WINDOW_TOKENS;
    try {
      const command = this.deps.stores.commands.command(
        stored.session.commandId,
      );
      return this.deps.stores.commands.definition(command.definitionId).budget
        .modelWindowTokens;
    } catch {
      return DEFAULT_HANDOFF_WINDOW_TOKENS;
    }
  }

  /* ------------------------------------------------------- the completion loop */

  /**
   * A submission (§3.5): the session says it is done, PlotRoom checks the
   * declared conditions itself, and the answer is either proof or feedback. The
   * session is never told it succeeded because it said so.
   */
  async submit(input: {
    readonly sessionId: string;
    readonly outputs?: readonly {
      readonly name: string;
      readonly objectId: string;
      readonly versionId: string;
    }[];
    readonly actor: Author;
  }): Promise<SubmissionResult> {
    const { stores } = this.deps;
    const session = stores.sessions.get(input.sessionId);

    if (session.runId === null) {
      return this.feedback(
        input.sessionId,
        null,
        "this session has no run to submit against; an open session ends when you end it (§3.5)",
      );
    }

    const run = stores.runs.run(session.runId);
    if (run.status !== "running") {
      return this.feedback(
        input.sessionId,
        run.id,
        `run ${run.id} already ended as ${run.status}; nothing more to submit`,
      );
    }

    const outcome = run.configuration.outcome;
    if (outcome === null) {
      return this.feedback(
        input.sessionId,
        run.id,
        "this command declares no outcome, so there is nothing to prove; end the session when you are done (§3.5)",
      );
    }

    const workspace =
      session.workspaceId === null
        ? null
        : stores.workspaces.get(session.workspaceId);
    const workspacePath = workspace?.roots[0]?.path ?? null;

    const evaluations: ConditionEvaluation[] =
      workspace === null || workspacePath === null
        ? outcome.conditions.map((condition) => ({
            conditionId: condition.id,
            holds: false,
            detail:
              "this session has no provisioned workspace, so nothing could be checked",
          }))
        : await this.deps.conditions.evaluate(outcome.conditions, {
            workspace,
            workspacePath,
          });

    const result = stores.runs.complete(run.id, {
      evaluations,
      cost: this.costOf(input.sessionId),
      ...(input.outputs === undefined ? {} : { outputs: input.outputs }),
    });

    stores.runs.recordSubmission({
      runId: run.id,
      sessionId: input.sessionId,
      accepted: result.accepted,
      evaluations,
      ...(result.accepted ? {} : { feedback: result.feedback }),
    });

    if (!result.accepted) {
      // The failing condition goes back to the session, which continues within
      // its budget (§3.5). Nothing about the run changes: it is still running.
      await this.deliverFeedback(
        input.sessionId,
        result.feedback,
        result.failed.map((evaluation) => evaluation.conditionId),
      );
      return {
        accepted: false,
        feedback: result.feedback,
        failed: result.failed,
        evaluations,
      };
    }

    // Proof, recorded point-in-time and never revoked: a condition that
    // regresses later is drift on done work, not an unmade completion
    // (principle 3, §4.5).
    const ended = stores.sessions.end(input.sessionId, {
      kind: "completed",
      at: result.proof.provenAt,
    });

    this.publishRun(result.run, input.actor);
    this.publishSession(ended, input.actor);

    const live = this.deps.hub.get(input.sessionId);
    if (live) await live.handle.stop("graceful");

    return {
      accepted: true,
      proof: result.proof,
      evaluations,
      run: result.run,
    };
  }

  /* ------------------------------------------------------------- end states */

  /** Stop at the session scope (§6.7). Out-of-budget is its own outcome (§8). */
  async stopSession(input: StopSessionInput): Promise<StoredSession> {
    const { stores } = this.deps;
    stores.sessions.get(input.sessionId);
    const at = stores.clock();

    const end: SessionEnd =
      input.cause === "budget"
        ? classifyEnd({ kind: "stopped", by: "user" }, at, {
            budgetStop: { scope: input.scope ?? "run" },
          })
        : { kind: "stopped", by: "user", at };

    // Recorded before the runtime is touched, deliberately: stopping the handle
    // makes the adapter report its own end reason, and the first outcome wins
    // (principle 9). PlotRoom's reason must therefore be written first, or an
    // out-of-budget stop would land as an ordinary one (§3.6, §8).
    const stopped = stores.sessions.end(input.sessionId, end);

    const live = this.deps.hub.get(input.sessionId);
    if (live) {
      await live.handle.stop(input.mode === "hard" ? "abort" : "graceful");
    }

    await this.endRunFor(stopped);
    this.publishSession(stopped, { kind: "human" });

    return stopped;
  }

  /**
   * §3.5: an open session ends when the user ends it. A producing one does not —
   * it ends on proven completion, or it is stopped, and calling this on one is
   * refused rather than quietly recorded as something it was not.
   */
  async endOpenSession(
    sessionId: string,
    actor: Author = { kind: "human" },
  ): Promise<StoredSession> {
    const { stores } = this.deps;
    const session = stores.sessions.get(sessionId);

    if (session.session.mode === "producing") {
      throw refused({
        reason: "producing_session",
        message:
          "a producing session ends on proven completion; stop it if you want it to stop",
      });
    }

    // Written before the runtime is stopped, for the same reason as a stop: the
    // adapter's report must not win over the outcome PlotRoom knows. Through
    // `classifyEnd` like every other end, carrying the actor the runtime could
    // not know — it sees its input close, not who closed it (§3.6).
    const ended = stores.sessions.end(
      sessionId,
      classifyEnd({ kind: "ended-by-user" }, stores.clock(), {
        endedBy: actor,
      }),
    );

    const live = this.deps.hub.get(sessionId);
    if (live) await live.handle.stop("graceful");

    await this.endRunFor(ended);
    this.publishSession(ended, actor);

    return ended;
  }

  /**
   * Recovery at process start, for the case nothing could be tidied: the last
   * process died rather than shut down.
   *
   * Two things are true the moment this runs and at no other time: every session
   * still marked live was in flight when the process died — recorded as
   * **interrupted**, not stopped and not failed, and resumable like any session
   * (principle 11) — and no initiation attempt can still be in progress, so a
   * key claimed but never settled is stranded and is freed rather than refusing
   * that gesture forever (principle 9).
   */
  async recoverFromRestart(message: string): Promise<RestartRecovery> {
    // A queued run the last process was in the middle of starting cannot still be
    // starting: the process that was starting it is gone. It goes back to
    // `queued`, where it will be re-previewed against its recorded contract like
    // any other admission — a restart is not a reason to run something the
    // operator did not agree to (§4.1).
    const requeued = this.deps.stores.queue.reclaimUnstarted();
    if (requeued.length > 0) {
      this.deps.logger.warn("re-queued runs a restart interrupted", {
        entryIds: requeued.map((entry) => entry.id),
      });
    }

    const stranded = this.deps.stores.runs.releaseUnsettledInitiations();
    if (stranded.length > 0) {
      this.deps.logger.warn("freed initiation keys no attempt can still hold", {
        keys: stranded,
      });
    }

    const interrupted = this.deps.stores.sessions.interruptInFlight(message);
    for (const session of interrupted) {
      await this.endRunFor(session);
      this.deps.logger.warn("session interrupted by a restart", {
        sessionId: session.session.id,
      });
    }

    return { interrupted, freedInitiationKeys: stranded };
  }

  /**
   * Shutdown, for the case something *can* be tidied (principle 11 again, from
   * the other side).
   *
   * A graceful close must not orphan a runtime: a pi child left running would
   * keep spending money and writing to a workspace nothing is watching. So the
   * outcome is written first — **interrupted**, because nobody stopped this work
   * and it did not fail — and then the process is terminated. Writing first is
   * what makes the record honest: terminating a runtime makes it report a stop,
   * and the first outcome wins (principle 9).
   *
   * Next-boot marking stays for real crashes, where this never got to run.
   */
  async shutdown(message: string): Promise<readonly StoredSession[]> {
    const { stores, hub } = this.deps;
    const ended: StoredSession[] = [];
    const pumps: Promise<void>[] = [];

    for (const sessionId of [...hub.ids()]) {
      const live = hub.get(sessionId);
      if (live === null) continue;
      pumps.push(live.pump);

      const stored = stores.sessions.get(sessionId);
      if (stored.session.end === null) {
        const at = stores.clock();
        const interrupted = stores.sessions.end(
          sessionId,
          classifyEnd({ kind: "interrupted", message }, at, {
            interrupted: { message },
          }),
        );
        await this.endRunFor(interrupted);
        this.publishSession(interrupted, { kind: "human" });
        ended.push(interrupted);

        this.deps.logger.warn("session interrupted by a shutdown", {
          sessionId,
        });
      }

      // Abort rather than wind down: the server is going away, and a runtime
      // asked to finish its turn would outlive the process that records it.
      await live.handle.stop("abort").catch((error: unknown) =>
        this.deps.logger.error("a runtime would not stop", {
          sessionId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }

    // Let the pumps drain what the abort produced, so nothing writes to a
    // database that is about to close. Bounded: a runtime that will not end its
    // stream must not hold the process open.
    await Promise.race([
      Promise.allSettled(pumps),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS).unref()),
    ]);

    hub.detachAll();

    return ended;
  }

  /* ----------------------------------------------------------------- private */

  /**
   * Attach the observation pump. Everything after this point is derived: the
   * log is appended, the phase is folded, and the stream is published — the same
   * path for every adapter, which is what makes the scripted runtime a
   * legitimate stand-in rather than a second implementation.
   */
  private attach(
    sessionId: string,
    handle: RuntimeSessionHandle,
    adapterId: string,
    modelWindowTokens: number,
  ): void {
    const pump = driveSession(
      {
        sessions: this.deps.stores.sessions,
        bus: this.deps.bus,
        logger: this.deps.logger,
        nowMillis: systemMillisClock,
        // §3.4's enforcement point and §3.6's claim-wait phase, both wired here
        // rather than optionally: a session whose writes nothing checks is not a
        // session this product knows how to run.
        gate: this.deps.gate,
        phaseContext: (id) => this.phaseContext(id),
        hooks: {
          onSubmission: async ({ sessionId: id, submission }) => {
            await this.submit({
              sessionId: id,
              actor: { kind: "session", sessionId: id as SessionId },
              ...(submission.outputs === undefined
                ? {}
                : { outputs: submission.outputs }),
            });
          },
          completionEvidence: (id) => this.completionEvidence(id),
          // §8, at the only honest moment: the session just spent something, so a
          // budget it is bound by may now be exhausted. Attribution and
          // enforcement both happen here — not on a schedule, because nothing in
          // this product runs on one (principle 2).
          onAccounting: async ({ sessionId: id }) => {
            await this.enforceBudget(id);
          },
          onQuestion: (question) => {
            if (this.#onQuestion === null) {
              this.deps.logger.error(
                "a runtime asked a question with nothing to receive it",
                { sessionId: question.sessionId },
              );
              return;
            }
            this.#onQuestion(question);
          },
          onEnded: async ({ sessionId: id }) => {
            await this.endRunFor(this.deps.stores.sessions.get(id));
            this.deps.hub.detach(id);
          },
        },
      },
      {
        sessionId,
        handle,
        adapterId,
        // The runtime reports no window occupancy, so the meter is estimated
        // against the command's declared model window and labelled as such.
        accounting: { contextWindowTokens: modelWindowTokens },
      },
    );

    this.deps.hub.attach(sessionId, { handle, adapterId, pump });
  }

  /**
   * What the world says about a session's declared outcome (principle 3, §3.5).
   *
   * Read from PlotRoom's own record and nowhere else: whether the declared
   * outcome was ever submitted, and which declared conditions PlotRoom checked
   * and found false. `checkProvenCompletion` in `@plotroom/core` is what turns
   * this into an answer — this only says what happened.
   */
  private completionEvidence(sessionId: string): CompletionEvidence {
    const { stores } = this.deps;
    const session = stores.sessions.get(sessionId);

    // An open session declares no outcome, so there is nothing it could ever
    // have proven — which core reads as the *more* unfounded claim, not the
    // lesser one.
    if (session.session.mode === "open") return { lifecycle: "open" };

    if (session.runId === null) {
      return {
        lifecycle: "producing",
        outcomeSubmitted: false,
        failedConditionIds: [],
      };
    }

    const submissions = stores.runs.submissions(session.runId);
    const accepted = submissions.some((attempt) => attempt.accepted);
    const latest = submissions.at(-1);

    return {
      lifecycle: "producing",
      outcomeSubmitted: submissions.length > 0,
      // Named rather than counted, so the recorded failure says which conditions
      // were false. An accepted submission has none by definition.
      failedConditionIds:
        accepted || latest === undefined
          ? []
          : latest.evaluations
              .filter((evaluation) => !evaluation.holds)
              .map((evaluation) => evaluation.conditionId),
    };
  }

  /**
   * The run stops being "running" when its session ends. The mapping is the
   * honest one: a stop is a stop, a failure says why, out-of-budget is its own
   * outcome, and an interruption says it was interrupted.
   *
   * The invariant this keeps is the one that matters for run history: **no ended
   * session leaves a running run behind**. A run stuck at "running" reads as
   * work still in flight on every surface that shows it, forever.
   */
  private async endRunFor(session: StoredSession): Promise<void> {
    const { stores } = this.deps;

    // "A session ending releases everything it held automatically; explicit yield
    // is an optimization" (§3.4). Done for every end, before anything about the
    // run is decided, because a wedged holder that kept its paths after ending
    // would block the next session for a whole lease.
    this.releaseClaims(session);
    this.attributeSpend(session);

    if (session.runId === null) return;

    const run = stores.runs.run(session.runId);
    if (run.status !== "running") return;

    const end = session.session.end;
    if (end === null) return;

    const cost = this.costOf(session.session.id);

    const ended = ((): Run => {
      switch (end.kind) {
        case "completed":
          // The submission path is the only place a run may be *completed*
          // (§3.5), and it has already done so by the time a session's end says
          // completed — so reaching here means the run was never completed and
          // is still open. It stops, saying exactly that, rather than being left
          // to look like work in flight.
          return stores.runs.stop(
            run.id,
            cost,
            "the session ended as completed without the run recording a proven outcome",
          );
        case "failed":
          return stores.runs.fail(run.id, end.message, cost);
        case "out-of-budget":
          return stores.runs.stopOutOfBudget(run.id, cost);
        case "stopped":
          return stores.runs.stop(run.id, cost, `stopped by ${end.by}`);
        case "ended-by-user":
          return stores.runs.stop(run.id, cost, "the user ended the session");
        case "interrupted":
          // Its own outcome on the run too, now that the taxonomy can say it
          // (principle 11): nobody stopped this work.
          return stores.runs.interrupt(run.id, end.message, cost);
      }
    })();

    this.publishRun(ended, { kind: "human" });
  }

  /**
   * Hand a failing condition back to the session as a new turn (§3.5).
   *
   * The ledger records it as the product's own feedback — it authors no context
   * and leaves no node, because PlotRoom is answering a submission rather than
   * steering (§6.5) — and `origin` is what tells the transcript to render it as
   * `@plotroom/core`'s `feedback` entry rather than as an injection nobody
   * authored.
   */
  private async deliverFeedback(
    sessionId: string,
    feedback: string,
    failedConditionIds: readonly string[],
    origin: "condition-feedback" | "budget-notice" = "condition-feedback",
  ): Promise<void> {
    const { stores } = this.deps;
    const id = `inj_${randomUUID()}`;
    const at = stores.clock();

    stores.sessions.queueInjection({
      id,
      sessionId,
      origin,
      text: feedback,
      // Named, so the transcript's `feedback` entry can say which conditions
      // were false rather than leaving the sentence to be parsed (§3.5, §6.1).
      failedConditionIds,
      queuedAt: at,
    });

    const live = this.deps.hub.get(sessionId);
    if (!live) {
      stores.sessions.markRefused(
        id,
        at,
        "the session was no longer live when the feedback was ready",
      );
      return;
    }

    try {
      await live.handle.inject({ id, text: feedback });
    } catch (error) {
      stores.sessions.markRefused(
        id,
        at,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private feedback(
    sessionId: string,
    runId: string | null,
    message: string,
  ): SubmissionResult {
    this.deps.logger.warn("submission refused", { sessionId, runId, message });
    return {
      accepted: false,
      feedback: message,
      failed: [],
      evaluations: [],
    };
  }

  /**
   * Provision at first run (§3.4, §3.5), then gate on readiness. Nothing here
   * happens when a workstream is created: a workspace record is cheap, a
   * checkout is not, and the spec says the cost is paid when work starts.
   */
  private async ensureWorkspace(
    workstreamId: string,
    actor: Author,
  ): Promise<Workspace> {
    const { stores, config, workspaceKinds } = this.deps;

    const lookup = workspaceKinds.require(config.workspace.kind);
    if (!lookup.available) throw refused(lookup.refusal);
    const kind = lookup.kind;

    let workspace =
      stores.workspaces.forWorkstream(workstreamId) ??
      stores.workspaces.create({
        workstreamId,
        kind: config.workspace.kind,
        config: this.workspaceConfig(workstreamId),
        author: actor,
      });

    const configCheck = kind.checkConfig(workspace.config);
    if (!configCheck.valid) throw refused(configCheck.refusal);

    if (
      workspace.readiness.state === "unprovisioned" ||
      workspace.readiness.state === "provision-failed"
    ) {
      workspace = stores.workspaces.setReadiness(
        workspace.id,
        readinessProvisioning(workspace.readiness, systemMillisClock()),
      );

      const outcome = await kind.provision({
        workspaceId: workspace.id,
        kind: workspace.kind,
        config: workspace.config,
        requestedAt: systemMillisClock(),
      });

      if (!outcome.provisioned) {
        const failed = stores.workspaces.setReadiness(
          workspace.id,
          readinessProvisionFailed(
            workspace.readiness,
            outcome.failure.message,
            systemMillisClock(),
          ),
        );
        this.deps.logger.error("workspace provisioning failed", {
          workspaceId: failed.id,
          reason: outcome.failure.reason,
          log: outcome.failure.log,
        });
        // The mechanism's own reason, verbatim (§3.4): a failed provisioning is
        // reported, never silently retried somewhere else.
        throw refused({
          reason: `workspace_${outcome.failure.reason}`,
          message: outcome.failure.message,
        });
      }

      const setup = resolveSetup(
        // The in-repository declaration reader is not built yet, so the settings
        // override is the only source; `resolveSetup` still decides which one
        // wins, rather than this call site.
        null,
        config.workspace.setup === null ? null : { ...config.workspace.setup },
      );

      workspace = stores.workspaces.recordProvisioned(workspace.id, {
        roots: outcome.roots,
        cost: outcome.cost,
        readiness: readinessProvisioned(
          workspace.readiness,
          setup,
          systemMillisClock(),
        ),
      });

      this.deps.logger.info("workspace provisioned", {
        workspaceId: workspace.id,
        strategy: outcome.cost.strategy,
        sharedCache: outcome.cost.sharedCache,
        elapsedMillis: outcome.cost.elapsedMillis,
        notes: outcome.notes,
      });
    }

    if (
      workspace.readiness.state === "setup-required" ||
      workspace.readiness.state === "setup-failed"
    ) {
      const setup = workspace.readiness.setup;
      if (setup !== null) {
        const startedAt = systemMillisClock();
        const attempt = await kind.runSetup(workspace, setup, startedAt);
        workspace = stores.workspaces.setReadiness(
          workspace.id,
          readinessSetupFinished(
            readinessSetupStarted(workspace.readiness, attempt, startedAt),
            attempt,
            systemMillisClock(),
          ),
        );
      }
    }

    // The gate itself: not-ready blocks the run with the reason visible (§3.4).
    stores.workspaces.requireReady(workspace);

    return workspace;
  }

  /**
   * The git kind's configuration for this workstream. The branch comes from the
   * configured template, with the workstream's subject as its inputs — an
   * existing branch is never re-derived, which is the kind's own rule.
   */
  private workspaceConfig(workstreamId: string): WorkspaceKindConfig {
    const { stores, config } = this.deps;

    if (
      config.workspace.repositoryPath === null &&
      config.workspace.remoteUrl === null
    ) {
      throw refused({
        reason: "workspace_not_configured",
        message:
          "no repository is configured to branch from; set PLOTROOM_WORKSPACE_REPO (or a remote) before running work",
      });
    }

    const workstream = stores.workstreams.get(workstreamId);
    const subject =
      workstream?.subjectObjectId === null ||
      workstream?.subjectObjectId === undefined
        ? undefined
        : stores.objects.get(workstream.subjectObjectId);

    return {
      workspacePath: join(config.workspace.directory, workstreamId),
      repositoryPath: config.workspace.repositoryPath,
      remoteUrl: config.workspace.remoteUrl,
      strategy: "auto",
      branch: null,
      branchTemplate: config.workspace.branchTemplate,
      branchInputs: {
        type: "feat",
        ticket: subject?.externalId ?? workstreamId.slice(-8),
        title: subject?.title ?? "work",
      },
      baseRef: config.workspace.baseRef,
      remoteName: "origin",
      cacheDir: join(config.stateDir, "git-cache"),
    };
  }

  /**
   * Budget enforcement, at the one moment it can happen: the session just spent
   * something (§8, principle 2).
   *
   * The order is the whole of it. The spend is attributed up the chain **first**,
   * because an ancestor's cap counts what its descendants spent and a check
   * against a stale ledger would let a delegated dollar past every cap above it.
   * Then the tightest binding decides, and only two things can follow:
   *
   * - **at the cap** — PlotRoom stops the session, and the outcome recorded is
   *   `out-of-budget`: its own end state, distinct from failure, which a retry
   *   must not blindly re-run (§3.6). The chain that paid for it is told, so a
   *   parent learns why its child stopped rather than reading it as a failure;
   * - **near the cap** — the session is told once, with what remains and the
   *   instruction to wrap up cleanly (§8). Once, from a ledger row, so a restart
   *   between the warning and the cap cannot say it twice.
   *
   * Nothing here decides *whether* a cap exists or which one is tightest — that is
   * `@plotroom/core`'s rule reached through `BudgetService`, so the session-facing
   * read and this enforcement cannot disagree (principle 8).
   */
  private async enforceBudget(sessionId: string): Promise<void> {
    const { stores, budgets } = this.deps;
    const session = stores.sessions.get(sessionId);
    // Already ended: an observation buffered behind the stop is not a reason to
    // stop it again, and the first outcome is the one that stands (principle 9).
    if (session.session.end !== null) return;

    this.attributeSpend(session);
    const effective = budgets.forSession(sessionId);

    if (effective.state === "at-cap" && effective.tightest !== null) {
      const tightest = effective.tightest;
      this.deps.logger.warn("stopping a session out of budget", {
        sessionId,
        binding: `${tightest.kind}:${tightest.id}`,
        limitMicros: tightest.limitMicros,
        spentMicros: tightest.spentMicros,
      });

      await this.stopSession({
        sessionId,
        mode: "graceful",
        cause: "budget",
        scope: tightest.scope,
      });

      // "Report" (§8), to the chain that was charged for it. A stop notice is not
      // steering and authors nothing: it is PlotRoom saying what it did.
      for (const ancestor of budgets.ancestorsOf(sessionId)) {
        const notice = budgets.claimStopNotice(sessionId, ancestor, tightest);
        if (notice === null) continue;
        await this.deliverFeedback(ancestor, notice, [], "budget-notice");
      }
      return;
    }

    if (effective.state !== "near-cap") return;

    const warning = budgets.claimWarning(sessionId, effective);
    if (warning === null) return;
    await this.deliverFeedback(sessionId, warning, [], "budget-notice");
  }

  /**
   * The refusal before anything is recorded: a run that has no money to spend does
   * not start (§8).
   *
   * Reported as a refusal rather than started and immediately stopped, because a
   * run whose first turn is cut off leaves history saying work was attempted when
   * nothing was. For a delegated run the caller's whole chain is checked, not just
   * the target workstream — a child cannot spend a cap its parent has exhausted.
   */
  private budgetBlocker(
    workstreamId: string,
    actor: Author,
  ): RunRefusal | null {
    const effective =
      actor.kind === "session"
        ? this.deps.budgets.forSession(actor.sessionId)
        : this.deps.budgets.forWorkstream(workstreamId);

    if (effective.state !== "at-cap") return null;

    return {
      reason: "out_of_budget",
      message: `${effective.description}; raise or remove the cap before running this (§8)`,
    };
  }

  /**
   * Attribute what a session spent to every budget that binds it (§3.6,
   * principle 2): "its spend counts against every budget that binds the
   * initiating work."
   *
   * The chain is the recorded lineage, so a delegated dollar lands on the
   * delegator and on whoever started *them*, however many hops up. Idempotent per
   * (charged session, spender), because the accounting total is folded from the
   * observation log and re-attributing a grown total must replace the row rather
   * than add a second one.
   *
   * A session whose runtime reported no cost contributes no evidence about money
   * (§4.1's own rule about estimates, applied to the ledger): nothing is written.
   */
  private attributeSpend(session: StoredSession): void {
    const { stores } = this.deps;
    const { accounting } = stores.sessions.observationState(session.session.id);
    if (accounting.costUsd <= 0) return;

    const entries = stores.spend.attribute({
      chain: attributionChain(stores, session.session.id),
      workstreamId: session.session.workstreamId,
      spend: {
        sessionId: session.session.id,
        amountUsd: accounting.costUsd,
        // The basis is named, never assumed: a runtime-reported cost and one
        // priced from tokens are different evidence (§8).
        basis:
          accounting.costBasis === "runtime-reported" ? "reported" : "priced",
        at: stores.clock(),
      },
    });

    for (const entry of entries) {
      const total = stores.spend.sessionTotal(entry.sessionId);
      const workstreamId =
        stores.spend.workstreamOf(entry.sessionId) ??
        session.session.workstreamId;
      this.deps.bus.publish({
        entity: "session_spend",
        verb: "updated",
        sessionId: entry.sessionId,
        workstreamId: workstreamId as WorkstreamId,
        attributedMicros: total.amountMicros,
        sources: total.sources,
        author: { kind: "human" },
      });
    }
  }

  /**
   * Release what an ended session held (§3.4), idempotently: `endSession` on the
   * manager is a no-op once nothing is held, so a doubled end costs nothing.
   */
  private releaseClaims(session: StoredSession): void {
    if (session.session.end === null) return;
    this.deps.claims.endSession(
      session.session.workstreamId,
      session.session.id,
    );
  }

  private costOf(sessionId: string): RunCost {
    const { accounting } =
      this.deps.stores.sessions.observationState(sessionId);
    return {
      inputTokens: accounting.tokens.input,
      outputTokens: accounting.tokens.output,
      costMicros: Math.round(accounting.costUsd * 1_000_000),
    };
  }

  private statusOf(sessionId: string): SessionStatus {
    return this.deps.stores.sessions.status(sessionId, {
      now: systemMillisClock(),
      ...this.phaseContext(sessionId),
    });
  }

  /**
   * PlotRoom's own gates, folded into every phase derivation (§3.6).
   *
   * "Waiting on a claim" is a phase like thinking or responding, and it is the
   * one phase no runtime can report: only PlotRoom knows a session asked for a
   * path someone else holds. Derived by the claim manager from the wait rows, so
   * the card, the queue, and blocked-on accounting cannot disagree (§7.2).
   */
  private phaseContext(sessionId: string): {
    readonly waitingOnClaim: boolean;
  } {
    return { waitingOnClaim: this.deps.claims.isWaitingOnClaim(sessionId) };
  }

  private publishRun(
    run: Run,
    author: Author,
    verb: "created" | "updated" = "updated",
  ): void {
    this.deps.bus.publish({ entity: "run", verb, run, author });
  }

  private publishSession(session: StoredSession, author: Author): void {
    this.deps.bus.publish({
      entity: "session",
      verb: "updated",
      session: session.session,
      status: this.statusOf(session.session.id),
      author,
    });
  }
}

/**
 * The transcript prefix a seeded fork starts from, built the same way `planFork`
 * builds it: released tool output is reloaded first, and what could not be
 * reloaded is reported rather than silently dropped (principle 12).
 */
function seedFrom(
  stores: ApiStores,
  source: StoredSession,
  plan: SessionForkPlan,
): string {
  const { transcript } = stores.sessions.transcript(source.session.id);
  const prefix = transcriptPrefix(transcript, plan.point);
  const exported = exportTranscript(prefix, () => null);
  // The document either way: an incomplete export is still the honest prefix, and
  // `planFork` already reports the incompleteness on the plan (principle 12).
  return exported.complete
    ? transcriptRenderings(prefix).agentContent
    : exported.document;
}

export type SubmissionResult =
  | {
      readonly accepted: true;
      readonly proof: CompletionProof;
      readonly evaluations: readonly ConditionEvaluation[];
      readonly run: Run;
    }
  | {
      readonly accepted: false;
      readonly feedback: string;
      readonly failed: readonly ConditionEvaluation[];
      readonly evaluations: readonly ConditionEvaluation[];
    };

/**
 * What the preview says about a workspace that already exists, in the readiness
 * gate's own words (§3.4) — so the reason shown before a run is the reason a run
 * would refuse with, not a second wording of it.
 */
function readinessReason(workspace: Workspace): string | null {
  const check = checkReady(workspace.readiness);
  return check.ready ? null : check.refusal.message;
}
