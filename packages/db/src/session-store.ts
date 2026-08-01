import { and, eq, isNull, sql } from "drizzle-orm";
import {
  classifyEnd,
  deriveSessionStatus,
  endSession,
  epochSeconds,
  initialObservationState,
  markDelivered,
  markRefused,
  newSessionId,
  publishesVersion,
  reduceObservation,
  reduceTranscriptPublication,
  startSession,
  systemClock,
  transcriptRenderings,
  INITIAL_PUBLICATION_STATE,
  NOT_DELETED,
  type AccountingContext,
  type Author,
  type Clock,
  type CommandId,
  type InjectionEntry,
  type InjectionId,
  type NodeId,
  type ObjectId,
  type PhaseContext,
  type RunId,
  type RuntimeObservation,
  type Session,
  type SessionEnd,
  type SessionId,
  type SessionLaunchChoices,
  type SessionMode,
  type SessionRuntimeBinding,
  type SessionObservationState,
  type SessionPhase,
  type SessionStatus,
  type Transcript,
  type TranscriptEvent,
  type TranscriptPublication,
  type TranscriptPublicationState,
  type WorkspaceId,
  type WorkstreamId,
} from "@plotroom/core";
import type { PlotroomDatabase } from "./client.js";
import { EntityNotFound } from "./errors.js";
import { GraphStore } from "./graph-store.js";
import { ObjectStore } from "./object-store.js";
import {
  sessionInjections,
  sessionObservations,
  sessionTranscriptPublications,
  sessions,
  type SessionInjectionRow,
  type SessionRow,
} from "./schema.js";
import { transcriptFromObservations } from "./session-transcript.js";

/**
 * Sessions (spec §3.6), persisted.
 *
 * `@plotroom/core`'s `sessions/` subtree owns every rule this store keeps rows
 * for: the closed end-state taxonomy, the phase reducer, the checkpoint rule,
 * the injection ledger, accounting. Nothing here re-decides any of them —
 * phases are folded from the observation log by `reduceObservation` /
 * `deriveSessionStatus`, never reported by an agent (principle 7), and an end
 * state is written once, so a reconnect that observes an end twice cannot
 * rewrite "out of budget" into "stopped" (principle 9).
 *
 * The observation log is the record. The phase and accounting columns are a
 * snapshot of the fold, kept so a card renders without replaying the log — and
 * recomputable from it at any time, which is what makes them safe.
 */

export interface StartSessionInput {
  readonly workstreamId: string;
  /** The command that started it; null for an open session (§3.6). */
  readonly commandId?: string | null;
  /** The run it executes; a producing session always has one (§3.5). */
  readonly runId?: string | null;
  readonly workspaceId?: string | null;
  readonly mode: SessionMode;
  /** Per-session choices: model, effort, and the tool narrowing (§3.6). */
  readonly launch: SessionLaunchChoices;
  readonly initiatedBy: Author;
  readonly runtime: SessionRuntimeBinding;
}

/**
 * A session record plus the links the domain type deliberately does not carry:
 * which run it executes, which workspace it works in, and which object its
 * transcript is. The domain `Session` is the session; these are the joins.
 */
export interface StoredSession {
  readonly session: Session;
  readonly runId: RunId | null;
  readonly workspaceId: WorkspaceId | null;
  readonly transcriptObjectId: ObjectId | null;
  /** The last derived phase, snapshotted from the fold over the log. */
  readonly phase: SessionPhase;
}

/** One stored observation, in order. `seq` is the log's ordering primitive. */
export interface StoredObservation {
  readonly sessionId: SessionId;
  readonly seq: number;
  readonly observation: RuntimeObservation;
}

export interface QueueInjectionInput {
  readonly id: InjectionId;
  readonly sessionId: string;
  /**
   * Authored steering leaves a permanent content node on the graph (§6.5);
   * PlotRoom's own world-condition feedback authors nothing, so it carries
   * neither an author nor a node and is recorded as `condition-feedback`.
   */
  readonly origin: "steering" | "condition-feedback";
  readonly author?: Author;
  readonly nodeId?: string;
  readonly text: string;
  readonly queuedAt: number;
}

/** A ledger row. Only authored steering can become a core `InjectionEntry`. */
export interface StoredInjection {
  readonly id: InjectionId;
  readonly sessionId: SessionId;
  readonly origin: "steering" | "condition-feedback";
  readonly author: Author | null;
  readonly nodeId: NodeId | null;
  readonly text: string;
  readonly queuedAt: number;
  readonly deliveredAt: number | null;
  readonly refusedAt: number | null;
  readonly refusedReason: string | null;
}

export interface PublishTranscriptResult {
  readonly publication: TranscriptPublication;
  readonly objectId: ObjectId;
  readonly versionId: string;
}

export class SessionStore {
  private readonly objects: ObjectStore;
  private readonly graph: GraphStore;

  constructor(
    private readonly state: PlotroomDatabase,
    private readonly now: Clock = systemClock,
  ) {
    this.objects = new ObjectStore(state, now);
    this.graph = new GraphStore(state, now);
  }

  /**
   * Start a session record. The lineage row is written in the same act: the
   * initiation chain is principle 1's enforcement substrate, and a session that
   * existed without one would make the reflexivity refusal read empty data.
   */
  start(input: StartSessionInput): StoredSession {
    const id = newSessionId();
    const at = this.now();

    const session = startSession(
      {
        id,
        workstreamId: input.workstreamId as WorkstreamId,
        commandId: (input.commandId ?? null) as CommandId | null,
        mode: input.mode,
        launch: input.launch,
        initiatedBy: input.initiatedBy,
        runtime: input.runtime,
      },
      at,
    );

    const phase: SessionPhase = deriveSessionStatus(
      initialObservationState(at * 1000),
      { now: at * 1000 },
    ).phase;

    return this.state.db.transaction(() => {
      this.state.db
        .insert(sessions)
        .values({
          id,
          workstreamId: input.workstreamId,
          commandId: input.commandId ?? null,
          runId: input.runId ?? null,
          workspaceId: input.workspaceId ?? null,
          mode: input.mode,
          model: input.launch.model,
          effort: input.launch.effort,
          allowedToolsJson:
            input.launch.toolPermissions.allowedTools === null
              ? null
              : JSON.stringify(input.launch.toolPermissions.allowedTools),
          initiatedByKind: input.initiatedBy.kind,
          initiatedBySession:
            input.initiatedBy.kind === "session"
              ? input.initiatedBy.sessionId
              : null,
          adapterId: input.runtime.adapterId,
          runtimeRef: input.runtime.ref,
          phaseJson: JSON.stringify(phase),
          startedAt: session.startedAt,
          lastActivityAt: session.accounting.lastActivityAt,
        })
        .run();

      this.graph.recordLineage(
        id,
        input.initiatedBy.kind === "session"
          ? input.initiatedBy.sessionId
          : null,
      );

      return this.get(id);
    });
  }

  get(sessionId: string): StoredSession {
    return toStoredSession(this.row(sessionId));
  }

  list(
    options: {
      readonly workstreamId?: string;
      readonly includeDeleted?: boolean;
    } = {},
  ): StoredSession[] {
    return this.state.db
      .select()
      .from(sessions)
      .all()
      .filter(
        (row) =>
          (options.workstreamId === undefined ||
            row.workstreamId === options.workstreamId) &&
          (options.includeDeleted === true || row.deletedAt === null),
      )
      .map((row) => toStoredSession(row));
  }

  /** Sessions with no end recorded — what principle 11 interrupts at boot. */
  inFlight(): StoredSession[] {
    return this.state.db
      .select()
      .from(sessions)
      .where(and(isNull(sessions.endKind), isNull(sessions.deletedAt)))
      .all()
      .map((row) => toStoredSession(row));
  }

  /* ------------------------------------------------------------ observations */

  /** Append one observation. Returns the record, `seq` assigned. */
  appendObservation(
    sessionId: string,
    observation: RuntimeObservation,
  ): StoredObservation {
    this.row(sessionId);

    return this.state.db.transaction(() => {
      const max = this.state.db
        .select({ max: sql<number | null>`MAX(${sessionObservations.seq})` })
        .from(sessionObservations)
        .where(eq(sessionObservations.sessionId, sessionId))
        .get();
      const seq = (max?.max ?? 0) + 1;

      this.state.db
        .insert(sessionObservations)
        .values({
          sessionId,
          seq,
          at: observation.at,
          kind: observation.kind,
          observationJson: JSON.stringify(observation),
        })
        .run();

      return { sessionId: sessionId as SessionId, seq, observation };
    });
  }

  observationRecords(sessionId: string): StoredObservation[] {
    return this.state.db
      .select()
      .from(sessionObservations)
      .where(eq(sessionObservations.sessionId, sessionId))
      .orderBy(sessionObservations.seq)
      .all()
      .map((row) => ({
        sessionId: row.sessionId as SessionId,
        seq: row.seq,
        observation: JSON.parse(row.observationJson) as RuntimeObservation,
      }));
  }

  observations(sessionId: string): RuntimeObservation[] {
    return this.observationRecords(sessionId).map(
      (record) => record.observation,
    );
  }

  /**
   * The fold (§3.6, principle 7). Everything the product knows about a
   * session's phase and accounting comes from here — the log, through
   * `@plotroom/core`'s reducer — and never from an agent's own report.
   */
  observationState(
    sessionId: string,
    context: AccountingContext = {},
  ): SessionObservationState {
    const row = this.row(sessionId);
    let state = initialObservationState(row.startedAt * 1000);
    for (const observation of this.observations(sessionId)) {
      state = reduceObservation(state, observation, context);
    }
    return state;
  }

  status(
    sessionId: string,
    context: PhaseContext,
    accounting: AccountingContext = {},
  ): SessionStatus {
    return deriveSessionStatus(
      this.observationState(sessionId, accounting),
      context,
    );
  }

  /**
   * Snapshot the derived phase and accounting onto the row, so a card renders
   * without replaying the log. Never a source of truth: the log is.
   */
  saveDerived(
    sessionId: string,
    state: SessionObservationState,
    phase: SessionPhase,
  ): StoredSession {
    const { accounting } = state;

    this.state.db
      .update(sessions)
      .set({
        phaseJson: JSON.stringify(phase),
        turns: accounting.turns,
        inputTokens: accounting.tokens.input,
        outputTokens: accounting.tokens.output,
        cacheReadTokens: accounting.tokens.cacheRead,
        cacheWriteTokens: accounting.tokens.cacheWrite,
        costMicros: Math.round(accounting.costUsd * 1_000_000),
        costBasis: accounting.costBasis,
        contextUsedTokens: accounting.contextWindow?.usedTokens ?? null,
        contextMaxTokens: accounting.contextWindow?.maxTokens ?? null,
        contextBasis: accounting.contextWindow?.basis ?? null,
        lastActivityAt: accounting.lastActivityAt,
      })
      .where(eq(sessions.id, sessionId))
      .run();

    return this.get(sessionId);
  }

  /* -------------------------------------------------------------- end states */

  /**
   * Record the outcome. `endSession` keeps the first end (principle 9), so a
   * retry or a doubled observation cannot rewrite one outcome into another —
   * out-of-budget in particular, which a retry may not blindly re-run.
   */
  end(sessionId: string, end: SessionEnd): StoredSession {
    const stored = this.get(sessionId);
    const next = endSession(stored.session, end);
    if (next.end === null || stored.session.end !== null) return stored;

    this.state.db
      .update(sessions)
      .set({
        endKind: next.end.kind,
        endJson: JSON.stringify(next.end),
        endedAt: next.end.at,
      })
      .where(eq(sessions.id, sessionId))
      .run();

    // A session that ended is no longer running, so nothing wires into it
    // (§3.7). The node is the board's view of the same fact.
    const node = this.graph.findNodeFor("session", sessionId);
    if (node) this.graph.setRunning(node.id, false);

    return this.get(sessionId);
  }

  /**
   * Principle 11: a crash or restart with sessions in flight ends them as
   * **interrupted** — not stopped, not failed — and they stay resumable like any
   * session. Called at process start, before anything is served, so an operator
   * never sees a session the product believes is still running.
   */
  interruptInFlight(message: string): StoredSession[] {
    const at = this.now();
    return this.inFlight().map((stored) =>
      this.end(
        stored.session.id,
        classifyEnd({ kind: "interrupted", message }, at, {
          interrupted: { message },
        }),
      ),
    );
  }

  /* -------------------------------------------------------------- transcript */

  /** The transcript, projected from the log (§3.6): its content is what happened. */
  transcript(sessionId: string): {
    readonly transcript: Transcript;
    readonly completedTurns: number;
  } {
    const delivered = new Map(
      this.injections(sessionId)
        .filter((entry) => entry.author !== null && entry.deliveredAt !== null)
        .map((entry) => [
          entry.id as string,
          { author: entry.author as Author, text: entry.text },
        ]),
    );

    return transcriptFromObservations(
      sessionId as SessionId,
      this.observations(sessionId),
      delivered,
    );
  }

  publications(sessionId: string): TranscriptPublication[] {
    return this.state.db
      .select()
      .from(sessionTranscriptPublications)
      .where(eq(sessionTranscriptPublications.sessionId, sessionId))
      .orderBy(sessionTranscriptPublications.ordinal)
      .all()
      .map((row) => ({
        ordinal: row.ordinal,
        throughTurn: row.throughTurn,
        at: row.at,
        trigger: row.trigger,
        by:
          row.byKind === null
            ? null
            : row.byKind === "session"
              ? { kind: "session", sessionId: row.bySession as SessionId }
              : { kind: "human" },
      }));
  }

  /**
   * Apply the checkpoint rule (§3.6): a turn publishes nothing, a checkpoint or
   * a session end publishes the turns since the last one, and a publication with
   * nothing pending is not written at all — an empty version would drift every
   * consumer for no change. The decision is `@plotroom/core`'s reducer's; this
   * writes what it decided.
   */
  publishTranscript(
    sessionId: string,
    event: TranscriptEvent,
  ): PublishTranscriptResult | null {
    if (!publishesVersion(event)) return null;

    const stored = this.get(sessionId);
    const { transcript, completedTurns } = this.transcript(sessionId);
    const before = this.publicationState(sessionId, completedTurns);
    const after = reduceTranscriptPublication(before, event);
    const publication = after.publications.at(-1);

    if (
      publication === undefined ||
      after.publications.length === before.publications.length
    ) {
      return null;
    }

    const renderings = transcriptRenderings(transcript);
    const title = `Transcript · ${sessionId}`;

    return this.state.db.transaction(() => {
      const written =
        stored.transcriptObjectId === null
          ? this.objects.write({
              kind: "transcript",
              title,
              renderings,
              workstreamId: stored.session.workstreamId,
            })
          : this.objects.edit(stored.transcriptObjectId, { renderings, title });

      if (stored.transcriptObjectId === null) {
        this.state.db
          .update(sessions)
          .set({ transcriptObjectId: written.objectId })
          .where(eq(sessions.id, sessionId))
          .run();
      }

      this.state.db
        .insert(sessionTranscriptPublications)
        .values({
          sessionId,
          ordinal: publication.ordinal,
          throughTurn: publication.throughTurn,
          trigger: publication.trigger,
          byKind: publication.by?.kind ?? null,
          bySession:
            publication.by?.kind === "session"
              ? publication.by.sessionId
              : null,
          objectId: written.objectId,
          versionId: written.versionId,
          at: publication.at,
        })
        .run();

      return {
        publication,
        objectId: written.objectId as ObjectId,
        versionId: written.versionId,
      };
    });
  }

  /* --------------------------------------------------------------- injection */

  /**
   * Record queue acceptance — what `inject()` resolving actually proves (§6.5).
   * Delivery is a separate, observed fact, so the two are never collapsed into
   * one optimistic "sent".
   */
  queueInjection(input: QueueInjectionInput): StoredInjection {
    this.row(input.sessionId);

    if (
      input.origin === "steering" &&
      (input.author === undefined || input.nodeId === undefined)
    ) {
      throw new Error(
        "authored steering carries an author and the content node it left on the graph (§6.5)",
      );
    }

    // One gesture, one entry (principle 9): the ledger's dedup rule is the
    // primary key here, so a resent injection updates nothing.
    this.state.db
      .insert(sessionInjections)
      .values({
        id: input.id,
        sessionId: input.sessionId,
        origin: input.origin,
        authorKind: input.author?.kind ?? null,
        authorSession:
          input.author?.kind === "session" ? input.author.sessionId : null,
        nodeId: input.nodeId ?? null,
        text: input.text,
        queuedAt: input.queuedAt,
      })
      .onConflictDoNothing()
      .run();

    return this.injection(input.id);
  }

  /** The observed `injection-delivered` event, and only that (§6.5). */
  markDelivered(injectionId: string, at: number): StoredInjection {
    const entry = this.injection(injectionId);
    const ledger = markDelivered(
      toLedger(entry),
      injectionId as InjectionId,
      at,
    );
    const next = ledger.get(injectionId as InjectionId);
    if (!next || next.deliveredAt === null) return entry;

    this.state.db
      .update(sessionInjections)
      .set({ deliveredAt: next.deliveredAt })
      .where(eq(sessionInjections.id, injectionId))
      .run();

    return this.injection(injectionId);
  }

  markRefused(
    injectionId: string,
    at: number,
    reason: string,
  ): StoredInjection {
    const entry = this.injection(injectionId);
    const ledger = markRefused(
      toLedger(entry),
      injectionId as InjectionId,
      at,
      reason,
    );
    const next = ledger.get(injectionId as InjectionId);
    if (!next || next.refusedAt === null) return entry;

    this.state.db
      .update(sessionInjections)
      .set({ refusedAt: next.refusedAt, refusedReason: next.refusedReason })
      .where(eq(sessionInjections.id, injectionId))
      .run();

    return this.injection(injectionId);
  }

  injection(injectionId: string): StoredInjection {
    const row = this.state.db
      .select()
      .from(sessionInjections)
      .where(eq(sessionInjections.id, injectionId))
      .get();
    if (!row) throw new EntityNotFound("injection", injectionId);
    return toStoredInjection(row);
  }

  injections(sessionId: string): StoredInjection[] {
    return this.state.db
      .select()
      .from(sessionInjections)
      .where(eq(sessionInjections.sessionId, sessionId))
      .orderBy(sessionInjections.queuedAt)
      .all()
      .map((row) => toStoredInjection(row));
  }

  /* ----------------------------------------------------------------- private */

  /**
   * Rebuild the publication state the core reducer folds over: the turns
   * observed so far, with each recorded publication placed after the turn it
   * published through. Replaying rather than storing the reducer's state keeps
   * one description of the rule.
   */
  private publicationState(
    sessionId: string,
    completedTurns: number,
  ): TranscriptPublicationState {
    const recorded = this.publications(sessionId);
    let state = INITIAL_PUBLICATION_STATE;
    let next = 0;

    for (let turn = 1; turn <= completedTurns; turn += 1) {
      state = reduceTranscriptPublication(state, {
        kind: "turn-ended",
        at: 0,
        turn,
      });

      for (
        let publication = recorded[next];
        publication !== undefined && publication.throughTurn === turn;
        publication = recorded[next]
      ) {
        state = reduceTranscriptPublication(
          state,
          publication.trigger === "checkpoint"
            ? {
                kind: "checkpoint",
                at: publication.at,
                by: publication.by ?? { kind: "human" },
              }
            : {
                kind: "session-ended",
                at: publication.at,
                end: { kind: "completed", at: publication.at },
              },
        );
        next += 1;
      }
    }

    return state;
  }

  private row(sessionId: string): SessionRow {
    const row = this.state.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();
    if (!row) throw new EntityNotFound("session", sessionId);
    return row;
  }
}

function toStoredSession(row: SessionRow): StoredSession {
  const session: Session = {
    id: row.id as SessionId,
    workstreamId: row.workstreamId as WorkstreamId,
    commandId: (row.commandId ?? null) as CommandId | null,
    mode: row.mode,
    launch: {
      model: row.model,
      effort: row.effort,
      toolPermissions: {
        allowedTools:
          row.allowedToolsJson === null
            ? null
            : (JSON.parse(row.allowedToolsJson) as readonly string[]),
      },
    },
    initiatedBy:
      row.initiatedByKind === "session"
        ? { kind: "session", sessionId: row.initiatedBySession as SessionId }
        : { kind: "human" },
    runtime: { adapterId: row.adapterId, ref: row.runtimeRef },
    accounting: {
      turns: row.turns,
      startedAt: row.startedAt,
      lastActivityAt: row.lastActivityAt,
      tokens: {
        input: row.inputTokens,
        output: row.outputTokens,
        cacheRead: row.cacheReadTokens,
        cacheWrite: row.cacheWriteTokens,
      },
      costUsd: row.costMicros / 1_000_000,
      costBasis: row.costBasis,
      contextWindow:
        row.contextUsedTokens === null ||
        row.contextMaxTokens === null ||
        row.contextBasis === null
          ? null
          : {
              usedTokens: row.contextUsedTokens,
              maxTokens: row.contextMaxTokens,
              basis: row.contextBasis,
            },
    },
    end: row.endJson === null ? null : (JSON.parse(row.endJson) as SessionEnd),
    deletion:
      row.deletedAt === null
        ? NOT_DELETED
        : { deletedAt: row.deletedAt, deletedBy: null, restoredAt: null },
    startedAt: row.startedAt,
  };

  return {
    session,
    runId: (row.runId ?? null) as RunId | null,
    workspaceId: (row.workspaceId ?? null) as WorkspaceId | null,
    transcriptObjectId: (row.transcriptObjectId ?? null) as ObjectId | null,
    phase: JSON.parse(row.phaseJson) as SessionPhase,
  };
}

function toStoredInjection(row: SessionInjectionRow): StoredInjection {
  return {
    id: row.id as InjectionId,
    sessionId: row.sessionId as SessionId,
    origin: row.origin,
    author:
      row.authorKind === null
        ? null
        : row.authorKind === "session"
          ? { kind: "session", sessionId: row.authorSession as SessionId }
          : { kind: "human" },
    nodeId: (row.nodeId ?? null) as NodeId | null,
    text: row.text,
    queuedAt: row.queuedAt,
    deliveredAt: row.deliveredAt,
    refusedAt: row.refusedAt,
    refusedReason: row.refusedReason,
  };
}

/**
 * The core ledger functions take and return a ledger, so a single row is lifted
 * into one to be updated by them rather than by a second implementation of
 * "delivered wins once". Feedback rows have no author, so they are lifted with
 * a placeholder that is never read back — only the timestamps are.
 */
function toLedger(
  entry: StoredInjection,
): ReadonlyMap<InjectionId, InjectionEntry> {
  return new Map<InjectionId, InjectionEntry>([
    [
      entry.id,
      {
        id: entry.id,
        sessionId: entry.sessionId,
        author: entry.author ?? { kind: "human" },
        nodeId: (entry.nodeId ?? "") as NodeId,
        text: entry.text,
        queuedAt: entry.queuedAt,
        deliveredAt: entry.deliveredAt,
        refusedAt: entry.refusedAt,
        refusedReason: entry.refusedReason,
      },
    ],
  ]);
}

/** Re-exported beside the store that persists them, as `ObjectStore` does. */
export { epochSeconds };
