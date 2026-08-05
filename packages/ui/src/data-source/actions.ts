/**
 * The mutation half of talking to the real server (Sync 2): every gesture
 * the canvas already offers — placing an object, wiring context, creating a
 * workstream, writing a note — goes through the same `/api` endpoints an
 * agent tool will (principle 8), over the same same-origin `HttpClient`.
 *
 * A 409 is a refusal, not a failure: `checkConnection`'s reason travels back
 * from the server verbatim (Epic 2.2, `apps/server/src/http/domain-errors.ts`),
 * and this module turns it into a typed `{ ok: false, refusal }` a caller
 * can show — never a caught-and-ignored exception, and never treated as the
 * gesture having succeeded. Anything else (network failure, a genuine server
 * error) is not a refusal and is left to throw, because pretending an
 * unrelated failure was "the answer is no" would hide a real bug.
 */

import type { ContinueVsFresh, NodeRole } from "@plotroom/core";

import type { RestorableKind } from "../restorable/types.js";

import type { Point } from "../solver/push.js";
import {
  HttpError,
  type HttpClient,
  type RequestOptions,
} from "../transport/http.js";

export interface ApiRefusal {
  readonly reason: string;
  readonly message: string;
}

export type ActionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: ApiRefusal };

async function asAction<T>(call: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (err) {
    if (err instanceof HttpError && err.isRefusal) {
      return {
        ok: false,
        refusal: { reason: err.reason ?? "refused", message: err.message },
      };
    }
    throw err;
  }
}

export interface PlaceNodeInput {
  readonly role: NodeRole;
  readonly refId: string;
  readonly workstreamId?: string;
  readonly running?: boolean;
}

export interface AddContextEdgeInput {
  readonly from: string;
  readonly to: string;
  readonly ordinal?: number;
}

/** One node's slot in a batched arrangement move (§5, `PATCH /api/arrangement`). */
export interface ArrangementEntry {
  readonly nodeId: string;
  readonly position: Point;
}

export interface CreateNoteInput {
  readonly title: string;
  readonly body: string;
  readonly workstreamId?: string;
}

export interface InstantiateCommandInput {
  readonly definitionId: string;
  readonly workstreamId: string;
  /** Existing node ids wired as context in the same gesture (§3.5). */
  readonly context?: readonly string[];
}

export interface RunCommandInput {
  readonly commandId: string;
  /**
   * The caller's own idea of "this gesture" (principle 9) — a retry with the
   * same key is the same run and the same session, never a second one. The
   * canvas run gesture generates a fresh one per click; a caller retrying an
   * in-flight request reuses the same key instead.
   */
  readonly initiationKey: string;
}

export interface InjectInput {
  readonly sessionId: string;
  readonly text: string;
  /** The caller's own idea of "this gesture" (principle 9); a fresh one per send. */
  readonly injectionId?: string;
}

export interface AnswerQuestionInput {
  readonly questionId: string;
  readonly optionId: string;
  readonly text?: string;
}

/**
 * Handoff (§6.3): a brief the source session drafts, a human reviews
 * (editing or not), and only then does sending seed the new session
 * (`apps/server/src/routes/continuation.ts`'s trio, already live). Three
 * shapes rather than one, matching the server's own: writing never sends,
 * reviewing is the operator's alone, and sending is a separate gesture from
 * either.
 */
export interface HandoffBrief {
  readonly id: string;
  readonly sourceSessionId: string;
  readonly text: string;
  readonly origin: "session-written" | "derived";
  readonly state: "drafted" | "reviewed";
}

export interface WriteHandoffBriefInput {
  readonly sessionId: string;
  /** Omit to derive one from the log, labelled as derived (§6.3). */
  readonly text?: string;
}

export interface ReviewHandoffBriefInput {
  readonly briefId: string;
  /** The words as the operator wants them sent; omit to send the draft unchanged. */
  readonly text?: string;
}

export interface SendHandoffInput {
  readonly briefId: string;
  readonly workstreamId: string;
  readonly initiationKey: string;
}

export type StopScopeInput =
  | { readonly scope: "session"; readonly sessionId: string }
  | { readonly scope: "workstream"; readonly workstreamId: string }
  | { readonly scope: "everything" };

export interface StopPreview {
  readonly scope: StopScopeInput["scope"];
  readonly sessionIds: readonly string[];
  /** How many sessions this scope would stop — named before the gesture is made (§6.7). */
  readonly count: number;
  /** False when nothing is running in scope — disabled, not silent. */
  readonly enabled: boolean;
  /** True at the widest scope only (§6.7): the gesture refuses without `confirm: true`. */
  readonly requiresConfirmation: boolean;
  /** The sentence every stop surface shows, so they never disagree. */
  readonly description: string;
}

export interface GraphActions {
  createWorkstream(
    subjectId?: string,
  ): Promise<ActionResult<{ readonly workstreamId: string }>>;
  placeNode(
    input: PlaceNodeInput,
  ): Promise<ActionResult<{ readonly nodeId: string }>>;
  removeNode(nodeId: string): Promise<ActionResult<void>>;
  /**
   * Durable placement, one node (§5, §12): the drag gesture that moved
   * exactly one node with nothing to push — `PATCH /api/nodes/:id/position`,
   * one transaction, one row. A gesture that displaced neighbours too calls
   * {@link GraphActions.setArrangement} instead, never this in a loop (one
   * gesture is one transaction, principle 9).
   */
  setNodePosition(
    nodeId: string,
    position: Point,
    options?: RequestOptions,
  ): Promise<ActionResult<void>>;
  /**
   * Durable placement, a whole selection at once (§5, §12): a rigid-body
   * push displaces neighbours in the same gesture that moved the dragged
   * node, so the whole settled arrangement is one transaction —
   * `PATCH /api/arrangement`, never a half-applied move.
   */
  setArrangement(
    positions: readonly ArrangementEntry[],
    options?: RequestOptions,
  ): Promise<ActionResult<void>>;
  /**
   * "Reset arrangement" (§5's only automatic-layout verb), gone durable:
   * `POST /api/reset` with scope `"arrangement"`, confirmed inline — the
   * operator's own gesture *is* the confirmation, the same as every other
   * one-click verb here, and the scope removes nothing but where things sit
   * (`apps/server/src/maintenance/reset.ts`). The caller still has to force
   * a fresh snapshot afterward (`GraphDataSource.refresh`): this clears the
   * authored rows but publishes nothing on `/ws`.
   */
  resetArrangement(): Promise<
    ActionResult<{ readonly arrangedNodesCleared: number }>
  >;
  addContextEdge(
    input: AddContextEdgeInput,
  ): Promise<ActionResult<{ readonly edgeId: string }>>;
  removeEdge(edgeId: string): Promise<ActionResult<void>>;
  createNote(
    input: CreateNoteInput,
  ): Promise<ActionResult<{ readonly objectId: string }>>;
  editNote(
    objectId: string,
    input: { readonly title?: string; readonly body: string },
  ): Promise<ActionResult<void>>;
  /**
   * Run one command (§4.1): idempotent in the initiation key, and bounded
   * by the global concurrency limit like every other initiation (Batch 3's
   * decision). Two-shaped on success, matching the server's own two-shaped
   * response: a free slot starts the session immediately (`kind:
   * "started"`); an admitted-but-waiting gesture answers `kind: "queued"`
   * with its position, cancellable before it starts via `cancelQueuedRun`.
   * Refusal reasons (workspace not ready, budget exceeded, ...) travel back
   * verbatim either way — surfaced, never swallowed.
   */
  runCommand(input: RunCommandInput): Promise<
    ActionResult<
      | {
          readonly kind: "started";
          readonly runId: string;
          readonly sessionId: string;
        }
      | {
          readonly kind: "queued";
          readonly queueEntryId: string;
          readonly position: number | null;
        }
    >
  >;
  /** "Cancellable before it starts" (§4.1) — refused once it has. */
  cancelQueuedRun(
    queueEntryId: string,
  ): Promise<ActionResult<{ readonly cancelled: boolean }>>;
  /** A command definition dropped onto a bare ticket (§3.5, §3.3), post-workstream. */
  instantiateCommand(
    input: InstantiateCommandInput,
  ): Promise<
    ActionResult<{ readonly commandId: string; readonly nodeId: string }>
  >;
  /** Drag-reordered context inputs (§3.5): the given order becomes assembly order. */
  reorderContext(
    nodeId: string,
    edgeIds: readonly string[],
  ): Promise<ActionResult<void>>;
  /**
   * The transcript checkpoint gesture (§3.6, §6.1): "a live transcript
   * versions on checkpoint, not on every turn." `publication` is `null`
   * when there was nothing new to publish — the server says so rather than
   * this pretending a version was created.
   */
  checkpointTranscript(sessionId: string): Promise<
    ActionResult<{
      readonly publication: {
        readonly ordinal: number;
        readonly throughTurn: number;
      } | null;
    }>
  >;
  /**
   * Add content to a running session mid-flight (§6.5). `status` is
   * `queued` or `refused` (a live but unattached runtime) — never
   * `delivered`: that is the separate observed fact the ledger
   * (`SessionDataSource.subscribeInjections`) reports, never assumed here.
   */
  injectIntoSession(input: InjectInput): Promise<
    ActionResult<{
      readonly injectionId: string;
      readonly status: "queued" | "refused";
      readonly refusedReason: string | null;
    }>
  >;
  /**
   * Answer a structured question (§6.4), inline from its bubble or the
   * panel — the same endpoint either way. `settled` is false for a question
   * raised over HTTP rather than blocking a runtime call.
   */
  answerQuestion(
    input: AnswerQuestionInput,
  ): Promise<ActionResult<{ readonly settled: boolean }>>;
  /**
   * What a stop would cover, without making it (§6.7) — a read, so looking
   * is free. Not wrapped in `ActionResult`: a preview never refuses, it only
   * ever answers with a count (possibly zero) and whether it is enabled.
   */
  previewStop(scope: StopScopeInput): Promise<StopPreview>;
  /**
   * Stop at a scope (§6.7). The widest scope refuses with
   * `confirmation_required` unless `confirm` is set — the same refusal
   * channel every other gesture uses, so a caller catches it the same way
   * ("stop everything" answers this, a caller re-asks with `confirm: true`).
   */
  stopScope(
    input: StopScopeInput & { readonly confirm?: boolean },
  ): Promise<ActionResult<{ readonly stoppedSessionIds: readonly string[] }>>;
  /**
   * Resume an ended session (§6.3): the same record continues — the whole
   * difference from a fork. Typing into an ended session has no disposition
   * of its own (`dispositionOfTypedInput`); resume and fork are the two
   * explicit choices a caller makes instead.
   */
  resumeSession(input: {
    readonly sessionId: string;
    readonly initiationKey: string;
    readonly firstTurn?: string;
  }): Promise<
    ActionResult<{
      readonly sessionId: string;
      readonly firstTurnQueued: boolean;
    }>
  >;
  /**
   * Fork from a point (§6.3): a new session with its own workstream and
   * workspace, inheriting the conversation up to and including that turn.
   */
  forkSession(input: {
    readonly sessionId: string;
    readonly turn: number;
    readonly initiationKey: string;
  }): Promise<
    ActionResult<{
      readonly sessionId: string;
      readonly workstreamId: string;
      readonly mode: string;
    }>
  >;
  /**
   * Write the brief a handoff opens with (§6.3). Writing one sends
   * nothing — the operator reviews it first, as a separate gesture.
   */
  writeHandoffBrief(
    input: WriteHandoffBriefInput,
  ): Promise<ActionResult<{ readonly brief: HandoffBrief }>>;
  /** The briefs a session has written, so the operator can pick one up later. */
  listHandoffBriefs(
    sessionId: string,
  ): Promise<{ readonly briefs: readonly HandoffBrief[] }>;
  /**
   * The human's review — the only path from a draft to something sendable
   * (§6.3). Refuses a session author (the operator alone reviews).
   */
  reviewHandoffBrief(
    input: ReviewHandoffBriefInput,
  ): Promise<ActionResult<{ readonly brief: HandoffBrief }>>;
  /**
   * Send a reviewed brief (§6.3): seeds a new session, wired in by the
   * reviewer (§15-2, principle 5).
   */
  sendHandoff(input: SendHandoffInput): Promise<
    ActionResult<{
      readonly sessionId: string;
      readonly briefNodeId: string;
    }>
  >;
  /**
   * §4.3's decision, side by side (Batch 3 carry-over): what continuing
   * sends against what a fresh run sends, each mode's own gates. A read, so
   * looking is free — not wrapped in `ActionResult`, matching `previewStop`.
   */
  getContinuation(commandId: string): Promise<ContinueVsFresh>;
  /**
   * Delete a session record (§3.6, issue #65) — stopped first if it was
   * still live, and the same effect either way, so a card's delete gesture
   * never has to decide that itself. `restorable` in the server's own
   * response is always `true` (principle 10); nothing here needs to branch
   * on it, so it is not carried through.
   */
  deleteSession(
    sessionId: string,
  ): Promise<ActionResult<{ readonly stopped: boolean }>>;
  /**
   * Undo one (principle 10, issue #65): every entity `GET /api/restorable`
   * lists carries its own `POST .../restore` verb, and this is the one
   * dispatcher that picks the right path for each `RestorableKind` — never a
   * guess from the id's shape.
   */
  restoreEntity(kind: RestorableKind, id: string): Promise<ActionResult<void>>;
}

export function createApiActions(http: HttpClient): GraphActions {
  return {
    createWorkstream: (subjectId) =>
      asAction(async () => {
        const response = await http.post<{
          workstream: { readonly id: string };
        }>("/api/workstreams", subjectId ? { subjectId } : {});
        return { workstreamId: response.workstream.id };
      }),

    placeNode: (input) =>
      asAction(async () => {
        const response = await http.post<{ node: { readonly id: string } }>(
          "/api/nodes",
          input,
        );
        return { nodeId: response.node.id };
      }),

    removeNode: (nodeId) =>
      asAction(async () => {
        await http.delete(apiPath("/api/nodes", nodeId));
      }),

    setNodePosition: (nodeId, position, options) =>
      asAction(async () => {
        await http.patch(
          `${apiPath("/api/nodes", nodeId)}/position`,
          { position },
          options,
        );
      }),

    setArrangement: (positions, options) =>
      asAction(async () => {
        await http.patch("/api/arrangement", { positions }, options);
      }),

    resetArrangement: () =>
      asAction(async () => {
        const response = await http.post<{
          confirmed: boolean;
          result: { readonly removed: Readonly<Record<string, number>> };
        }>("/api/reset", { scope: "arrangement", confirm: true });
        return {
          arrangedNodesCleared: response.result.removed.arrangedNodes ?? 0,
        };
      }),

    addContextEdge: (input) =>
      asAction(async () => {
        const response = await http.post<{ edge: { readonly id: string } }>(
          "/api/edges",
          input,
        );
        return { edgeId: response.edge.id };
      }),

    removeEdge: (edgeId) =>
      asAction(async () => {
        await http.delete(apiPath("/api/edges", edgeId));
      }),

    createNote: (input) =>
      asAction(async () => {
        const response = await http.post<{
          object: { readonly id: string };
        }>("/api/notes", input);
        return { objectId: response.object.id };
      }),

    editNote: (objectId, input) =>
      asAction(async () => {
        await http.patch(apiPath("/api/notes", objectId), input);
      }),

    instantiateCommand: (input) =>
      asAction(async () => {
        const response = await http.post<{
          command: { readonly id: string };
          node: { readonly id: string };
        }>("/api/commands", input);
        return { commandId: response.command.id, nodeId: response.node.id };
      }),

    runCommand: (input) =>
      asAction(async () => {
        const response = await http.post<{
          run: { readonly id: string } | null;
          session: { readonly id: string } | null;
          queued: {
            readonly id: string;
            readonly position: number | null;
          } | null;
        }>("/api/runs", input);
        if (response.run !== null && response.session !== null) {
          return {
            kind: "started" as const,
            runId: response.run.id,
            sessionId: response.session.id,
          };
        }
        if (response.queued !== null) {
          return {
            kind: "queued" as const,
            queueEntryId: response.queued.id,
            position: response.queued.position,
          };
        }
        // Neither shape the contract promises — not a refusal (no 409), and
        // pretending success here would be worse than throwing (principle 12).
        throw new Error(
          "POST /api/runs returned neither a started run nor a queued entry",
        );
      }),

    cancelQueuedRun: (queueEntryId) =>
      asAction(async () => {
        const response = await http.delete<{ readonly cancelled: boolean }>(
          apiPath("/api/run-queue", queueEntryId),
        );
        return { cancelled: response.cancelled };
      }),

    reorderContext: (nodeId, edgeIds) =>
      asAction(async () => {
        await http.post(contextOrderPath(nodeId), { edgeIds });
      }),

    checkpointTranscript: (sessionId) =>
      asAction(async () => {
        const response = await http.post<{
          published: {
            publication: {
              readonly ordinal: number;
              readonly throughTurn: number;
            };
          } | null;
        }>(checkpointPath(sessionId));
        return { publication: response.published?.publication ?? null };
      }),

    injectIntoSession: (input) =>
      asAction(async () => {
        const response = await http.post<{
          injectionId: string;
          status: "queued" | "refused";
          refusedReason: string | null;
        }>(`${apiPath("/api/sessions", input.sessionId)}/inject`, {
          text: input.text,
          ...(input.injectionId === undefined
            ? {}
            : { injectionId: input.injectionId }),
        });
        return {
          injectionId: response.injectionId,
          status: response.status,
          refusedReason: response.refusedReason,
        };
      }),

    answerQuestion: (input) =>
      asAction(async () => {
        const response = await http.post<{ settled: boolean }>(
          `${apiPath("/api/questions", input.questionId)}/answer`,
          {
            optionId: input.optionId,
            ...(input.text === undefined ? {} : { text: input.text }),
          },
        );
        return { settled: response.settled };
      }),

    previewStop: (scope) =>
      http.get<StopPreview>(`/api/stops/preview?${stopQuery(scope)}`),

    stopScope: (input) =>
      asAction(async () => {
        const response = await http.post<{ stopped: readonly string[] }>(
          "/api/stops",
          {
            scope: input.scope,
            ...(input.scope === "session"
              ? { sessionId: input.sessionId }
              : {}),
            ...(input.scope === "workstream"
              ? { workstreamId: input.workstreamId }
              : {}),
            confirm: input.confirm ?? false,
          },
        );
        return { stoppedSessionIds: response.stopped };
      }),

    resumeSession: (input) =>
      asAction(async () => {
        const response = await http.post<{
          session: { readonly id: string };
          firstTurnQueued: boolean;
        }>(`${apiPath("/api/sessions", input.sessionId)}/resume`, {
          initiationKey: input.initiationKey,
          ...(input.firstTurn === undefined
            ? {}
            : { firstTurn: input.firstTurn }),
        });
        return {
          sessionId: response.session.id,
          firstTurnQueued: response.firstTurnQueued,
        };
      }),

    forkSession: (input) =>
      asAction(async () => {
        const response = await http.post<{
          session: { readonly id: string };
          workstreamId: string;
          mode: string;
        }>(`${apiPath("/api/sessions", input.sessionId)}/fork`, {
          turn: input.turn,
          initiationKey: input.initiationKey,
        });
        return {
          sessionId: response.session.id,
          workstreamId: response.workstreamId,
          mode: response.mode,
        };
      }),

    writeHandoffBrief: (input) =>
      asAction(async () => {
        const response = await http.post<{ brief: HandoffBrief }>(
          `${apiPath("/api/sessions", input.sessionId)}/handoff-brief`,
          input.text === undefined ? {} : { text: input.text },
        );
        return { brief: response.brief };
      }),

    listHandoffBriefs: (sessionId) =>
      http.get<{ briefs: readonly HandoffBrief[] }>(
        `${apiPath("/api/sessions", sessionId)}/handoff-briefs`,
      ),

    reviewHandoffBrief: (input) =>
      asAction(async () => {
        const response = await http.post<{ brief: HandoffBrief }>(
          `${apiPath("/api/handoff-briefs", input.briefId)}/review`,
          input.text === undefined ? {} : { text: input.text },
        );
        return { brief: response.brief };
      }),

    sendHandoff: (input) =>
      asAction(async () => {
        const response = await http.post<{
          session: { readonly id: string };
          briefNodeId: string;
        }>("/api/handoffs", {
          briefId: input.briefId,
          workstreamId: input.workstreamId,
          initiationKey: input.initiationKey,
        });
        return {
          sessionId: response.session.id,
          briefNodeId: response.briefNodeId,
        };
      }),

    getContinuation: (commandId) =>
      http.get<ContinueVsFresh>(
        `${apiPath("/api/commands", commandId)}/continuation`,
      ),

    deleteSession: (sessionId) =>
      asAction(async () => {
        const response = await http.delete<{ readonly stopped: boolean }>(
          apiPath("/api/sessions", sessionId),
        );
        return { stopped: response.stopped };
      }),

    restoreEntity: (kind, id) =>
      asAction(async () => {
        await http.post(`${apiPath(RESTORE_PATH_PREFIX[kind], id)}/restore`);
      }),
  };
}

/** `scope=...&sessionId=...`/`workstreamId=...` — the query shape `GET /stops/preview` reads. */
function stopQuery(scope: StopScopeInput): string {
  const params = new URLSearchParams({ scope: scope.scope });
  if (scope.scope === "session") params.set("sessionId", scope.sessionId);
  if (scope.scope === "workstream") {
    params.set("workstreamId", scope.workstreamId);
  }
  return params.toString();
}

/** `/api/sessions/<id>/checkpoint` — same path-encoding rule as {@link apiPath}. */
function checkpointPath(sessionId: string): string {
  return `${apiPath("/api/sessions", sessionId)}/checkpoint`;
}

/** `/api/nodes/<id>/context/order` — same path-encoding rule as {@link apiPath}. */
function contextOrderPath(nodeId: string): string {
  return `/api/nodes/${encodeURIComponent(nodeId)}/context/order`;
}

/**
 * A fixed, literal API prefix plus one path-encoded id segment — never a
 * caller-supplied URL or host (the same-origin rule `HttpClient` itself
 * enforces), and `encodeURIComponent` keeps an id containing `/` or `?`
 * from being read as extra path segments or query parameters.
 */
function apiPath(prefix: string, id: string): string {
  return `${prefix}/${encodeURIComponent(id)}`;
}

/**
 * Every `GET /api/restorable` category has its own `POST .../restore` verb
 * (`apps/server/src/routes/restorable.ts`'s own doc comment: "undoing is the
 * same gesture wherever it is offered"). One table, so a new category is one
 * line here rather than a new branch scattered through `restoreEntity`.
 */
const RESTORE_PATH_PREFIX: Readonly<Record<RestorableKind, string>> = {
  object: "/api/objects",
  node: "/api/nodes",
  edge: "/api/edges",
  workstream: "/api/workstreams",
  command: "/api/commands",
  commandDefinition: "/api/command-definitions",
  session: "/api/sessions",
};
