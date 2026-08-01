import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  classifyEnd,
  readinessProvisionFailed,
  readinessProvisioned,
  readinessProvisioning,
  readinessSetupFinished,
  readinessSetupStarted,
  resolveSetup,
  systemMillisClock,
  type Author,
  type BudgetScope,
  type CompletionProof,
  type ConditionEvaluation,
  type Run,
  type RunCost,
  type RuntimeSessionHandle,
  type SessionEnd,
  type SessionId,
  type SessionStatus,
  type Workspace,
  type WorkspaceKindConfig,
  type WorkspaceKindRegistry,
} from "@plotroom/core";
import type { StoredSession } from "@plotroom/db";
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

export interface RunServiceDeps {
  readonly config: ServerConfig;
  readonly stores: ApiStores;
  readonly bus: EventBus;
  readonly logger: Logger;
  readonly runtimes: RuntimeRegistry;
  readonly workspaceKinds: WorkspaceKindRegistry;
  readonly conditions: ConditionCheckRegistry;
  readonly hub: SessionHub;
}

export class RunService {
  constructor(private readonly deps: RunServiceDeps) {}

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
        warning: null,
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

    const started = stores.runs.start({ commandId: input.commandId });
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
      await this.deliverFeedback(input.sessionId, result.feedback);
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
  async endOpenSession(sessionId: string): Promise<StoredSession> {
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
    // adapter's report must not win over the outcome PlotRoom knows.
    const ended = stores.sessions.end(sessionId, {
      kind: "ended-by-user",
      at: stores.clock(),
    });

    const live = this.deps.hub.get(sessionId);
    if (live) await live.handle.stop("graceful");

    await this.endRunFor(ended);
    this.publishSession(ended, { kind: "human" });

    return ended;
  }

  /**
   * Principle 11, at process start: every session that was in flight when the
   * process died is recorded as **interrupted** — not stopped, not failed — and
   * the run it was executing stops being "running" with that reason attached.
   */
  async recoverInterrupted(message: string): Promise<readonly StoredSession[]> {
    const interrupted = this.deps.stores.sessions.interruptInFlight(message);

    for (const session of interrupted) {
      await this.endRunFor(session);
      this.deps.logger.warn("session interrupted by a restart", {
        sessionId: session.session.id,
      });
    }

    return interrupted;
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
          onEnded: async ({ sessionId: id }) => {
            await this.endRunFor(this.deps.stores.sessions.get(id));
            this.deps.hub.detach(id);
          },
        },
      },
      {
        sessionId,
        handle,
        // The runtime reports no window occupancy, so the meter is estimated
        // against the command's declared model window and labelled as such.
        accounting: { contextWindowTokens: modelWindowTokens },
      },
    );

    this.deps.hub.attach(sessionId, { handle, adapterId, pump });
  }

  /**
   * The run stops being "running" when its session ends. The mapping is the
   * honest one: a stop is a stop, a failure says why, out-of-budget is its own
   * outcome, and an interruption says it was interrupted.
   */
  private async endRunFor(session: StoredSession): Promise<void> {
    const { stores } = this.deps;
    if (session.runId === null) return;

    const run = stores.runs.run(session.runId);
    if (run.status !== "running") return;

    const end = session.session.end;
    if (end === null) return;

    const cost = this.costOf(session.session.id);

    const ended = ((): Run => {
      switch (end.kind) {
        case "completed":
          // Completion is recorded by the submission path, which is the only
          // place a run may be completed at all (§3.5).
          return run;
        case "failed":
          return stores.runs.fail(run.id, end.message, cost);
        case "out-of-budget":
          return stores.runs.stopOutOfBudget(run.id, cost);
        case "stopped":
          return stores.runs.stop(run.id, cost, `stopped by ${end.by}`);
        case "ended-by-user":
          return stores.runs.stop(run.id, cost, "the user ended the session");
        case "interrupted":
          return stores.runs.stop(run.id, cost, `interrupted: ${end.message}`);
      }
    })();

    this.publishRun(ended, { kind: "human" });
  }

  /**
   * Hand a failing condition back to the session as a new turn (§3.5). It is
   * recorded in the injection ledger as the product's own feedback: it authors
   * no context and leaves no node, because PlotRoom is answering a submission
   * rather than steering (§6.5).
   */
  private async deliverFeedback(
    sessionId: string,
    feedback: string,
  ): Promise<void> {
    const { stores } = this.deps;
    const id = `inj_${randomUUID()}`;
    const at = stores.clock();

    stores.sessions.queueInjection({
      id,
      sessionId,
      origin: "condition-feedback",
      text: feedback,
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
    });
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
