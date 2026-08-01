/**
 * The state-change event vocabulary (Epic 2.1, spec principle 8).
 *
 * One vocabulary, not two: the WS stream the canvas renders live and the
 * agent-facing API describe the same mutations with the same names, so the
 * two surfaces cannot drift apart. `DomainEvent` is that vocabulary. It is
 * shaped, not transported, here — `@plotroom/core` has no knowledge of
 * WebSockets or HTTP; `apps/server` owns the publish/subscribe plumbing and
 * turns these into wire messages.
 *
 * Epic 2.2's mutations are the ones that will actually call `publish()` with
 * these shapes; this module is the seam they publish through, built ahead of
 * them so the wire contract exists before the first mutation lands.
 *
 * Each event carries the full current shape of the thing that changed (never
 * a partial diff) so a subscriber can render straight from the event with no
 * follow-up fetch — the same reasoning as full-snapshot run history (§15-1):
 * a partial record is a record you cannot trust on its own.
 */

import type { Author } from "./author.js";
import type {
  Claim,
  ClaimId,
  ClaimPolicy,
  ClaimPolicyId,
  ClaimReleaseReason,
  ClaimWait,
  ClaimWaitId,
} from "./claims/index.js";
import type {
  CommandDefinition,
  CommandNode,
  CommandOutput,
} from "./commands.js";
import type { AttentionItem, NotificationRoute } from "./attention/index.js";
import type { Integration } from "./integrations/index.js";
import type { Budget } from "./budgets.js";
import type { Edge, PlacedNode } from "./edges.js";
import type {
  CommandDefinitionId,
  CommandId,
  EdgeId,
  EventId,
  NodeId,
  ObjectId,
  OutputId,
  RunId,
  SessionId,
  VersionId,
  WorkstreamId,
} from "./ids.js";
import type { PlotObject } from "./objects.js";
import type {
  Approval,
  ApprovalAttention,
  BroadcastActivityEntry,
  BroadcastAttention,
  PreGrant,
  QuestionOption,
  SessionQuestion,
} from "./sessions/index.js";
import type { QueuedRun, Run, RunBatch } from "./runs.js";
import type {
  RuntimeObservation,
  Session,
  SessionStatus,
  TranscriptPublication,
} from "./sessions/index.js";
import type { ObjectVersion } from "./versions.js";
import type { Workstream } from "./workstreams.js";

/** The domain kinds this vocabulary covers (spec §3.1, Epic 2.1 scope). */
export const EVENT_ENTITIES = [
  "object",
  "version",
  "node",
  "edge",
  "workstream",
  "command_definition",
  "command",
  "command_output",
  "run",
  "session",
  "session_observation",
  "session_transcript",
  /**
   * Claims, waits, and policies (§3.4). One vocabulary, not a claims-only
   * channel: "waiting on a claim is an attention state", and an attention state
   * a surface has to poll for is the invisible stall the product exists to
   * prevent.
   */
  "claim",
  "claim_wait",
  "claim_policy",
  /** Scoped runs and the queue of already-initiated work (§4.1). */
  "run_batch",
  "run_queue_entry",
  /** Spend attributed up an initiating chain (§3.6, principle 2). */
  "session_spend",
  /**
   * A budget at workstream or global scope (§8). Its own entity because a cap is
   * not a property of the thing it binds: the global ceiling binds everything and
   * belongs to nothing, and a surface showing "what may still be spent" has to
   * hear about it changing without refetching the whole board.
   */
  "budget",
  /**
   * A structured question and its answer (§6.4). Its own entity rather than a
   * session update, because a question outlives the tool call it blocks and the
   * unpicked options stay visible after it is answered.
   */
  "session_question",
  /**
   * A broadcast (§6.5). Two shapes on one entity, matching the two surfaces §6.5
   * names: the attention row the operator sees, and the per-workstream activity
   * entry (§7.3). Both come from `@plotroom/core`, so the queue and the history
   * cannot describe the same broadcast differently.
   */
  "broadcast",
  /**
   * An approval raised or answered (§6.6). Its own entity for the same reason a
   * question is: it **outlives the call it blocks**, so a surface that rendered
   * it as a property of the session would have nothing to show the moment the
   * call settled.
   */
  "approval",
  /** A standing decision about capability, declared or withdrawn (§6.6). */
  "pre_grant",
  /**
   * One row of the attention derivation (§7). Full-entity like everything else
   * here, keyed by the item's own stable id — so applying one twice changes
   * nothing, and an item leaving the queue is a `deleted` naming that id.
   */
  "attention",
  /** An outbound notification route and its delivery health (§7.3). */
  "notification_route",
  /**
   * An integration instance (§9.1–§9.3): connected, disconnected, its scoping
   * changed, or its connection went healthy/broken. One vocabulary for the
   * connect flow's own state, so the settings surface and an outbound health
   * alert describe the same row rather than two.
   */
  "integration",
] as const;

export type EventEntity = (typeof EVENT_ENTITIES)[number];

/**
 * "created" and "updated" both carry the full entity so a subscriber never
 * has to reconcile a diff; "deleted" carries only the id, since there is
 * nothing left for a subscriber to draw.
 *
 * The verb describes what a surface should do, not how the row was stored. A
 * soft delete is "deleted": the row survives so the gesture can be undone
 * (principle 10), but the thing is off the board, and a canvas that kept
 * drawing it would be showing something the human deleted. Undoing one is
 * "created" — what the subscriber needs is the entity back, in full, and
 * there is deliberately no "restored" verb to special-case. Changes that
 * leave the thing on the board — archived, ended, status or subject set —
 * are "updated".
 */
export type EventVerb = "created" | "updated" | "deleted";

interface DomainEventEnvelope {
  /** Unique per event, for client-side dedup across reconnects. */
  readonly id: EventId;
  /**
   * Monotonically increasing within one server process — the ordering
   * primitive for the WS stream. Not persisted: a restart starts a new
   * sequence, and clients resync via a fresh snapshot over the REST API
   * (Epic 2.2), never by asking this stream to replay history.
   */
  readonly seq: number;
  readonly occurredAt: number;
  /** Who caused the change, mirroring §15-2's edge authorship rule. */
  readonly author: Author;
}

export type DomainEventBody =
  | {
      readonly entity: "object";
      readonly verb: "created" | "updated";
      readonly object: PlotObject;
    }
  | {
      readonly entity: "object";
      readonly verb: "deleted";
      readonly objectId: ObjectId;
    }
  | {
      readonly entity: "version";
      readonly verb: "created";
      readonly version: ObjectVersion;
    }
  | {
      readonly entity: "node";
      readonly verb: "created" | "updated";
      readonly node: PlacedNode;
    }
  | {
      readonly entity: "node";
      readonly verb: "deleted";
      readonly nodeId: NodeId;
    }
  | { readonly entity: "edge"; readonly verb: "created"; readonly edge: Edge }
  | {
      readonly entity: "edge";
      readonly verb: "deleted";
      readonly edgeId: EdgeId;
    }
  | {
      readonly entity: "workstream";
      readonly verb: "created" | "updated";
      readonly workstream: Workstream;
    }
  | {
      readonly entity: "workstream";
      readonly verb: "deleted";
      readonly workstreamId: WorkstreamId;
    }
  | {
      readonly entity: "command_definition";
      readonly verb: "created" | "updated";
      readonly definition: CommandDefinition;
    }
  | {
      readonly entity: "command_definition";
      readonly verb: "deleted";
      readonly definitionId: CommandDefinitionId;
    }
  | {
      readonly entity: "command";
      readonly verb: "created" | "updated";
      readonly command: CommandNode;
    }
  | {
      readonly entity: "command";
      readonly verb: "deleted";
      readonly commandId: CommandId;
    }
  | {
      readonly entity: "command_output";
      readonly verb: "created" | "updated";
      readonly output: CommandOutput;
    }
  | {
      readonly entity: "command_output";
      readonly verb: "deleted";
      readonly outputId: OutputId;
    }
  | {
      readonly entity: "run";
      readonly verb: "created" | "updated";
      readonly run: Run;
    }
  | { readonly entity: "run"; readonly verb: "deleted"; readonly runId: RunId }
  /**
   * A session and its derived status travel together, because a session card is
   * both: the record (launch choices, accounting, end state) and the phase
   * PlotRoom folded out of the observation log. The status is derived here and
   * never agent-reported (principle 7), so a subscriber renders the phase it is
   * given rather than inferring one from the record.
   *
   * This one shape covers created, phase change, accounting change, and end:
   * every one of them is "the session, as it now is".
   */
  | {
      readonly entity: "session";
      readonly verb: "created" | "updated";
      readonly session: Session;
      readonly status: SessionStatus;
    }
  | {
      readonly entity: "session";
      readonly verb: "deleted";
      readonly sessionId: SessionId;
    }
  /**
   * One appended observation record — turns, streamed deltas, tool calls,
   * requests, ends. `seqInSession` is 1-based per session and is the log's own
   * ordering primitive (distinct from the envelope's stream-wide `seq`), so
   * applying one twice is idempotent by (sessionId, seqInSession) and a
   * subscriber can tell a gap from a reorder.
   *
   * This is what a streaming transcript renders from: the log is the record
   * (§3.6), and PlotRoom's own observation vocabulary is what crosses the wire,
   * never a vendor payload (decision 0001).
   */
  | {
      readonly entity: "session_observation";
      readonly verb: "created";
      readonly sessionId: SessionId;
      readonly seqInSession: number;
      readonly observation: RuntimeObservation;
    }
  /**
   * A published transcript version (§3.6's checkpoint rule): consumers drift on
   * session end or an explicit checkpoint, never per turn — so this is a much
   * rarer event than the observation stream above, and that is the point.
   */
  | {
      readonly entity: "session_transcript";
      readonly verb: "created";
      readonly sessionId: SessionId;
      readonly publication: TranscriptPublication;
      readonly objectId: ObjectId;
      readonly versionId: VersionId;
    }
  /**
   * A claim granted, renewed, or reattached (§3.4). Carried whole, like every
   * other entity here, so the claims panel draws from the event.
   */
  | {
      readonly entity: "claim";
      readonly verb: "created" | "updated";
      readonly claim: Claim;
    }
  /**
   * A claim left the live state. The reason travels with it because §3.4 makes
   * them different facts: a yield is an optimization, an expiry is the lease
   * doing its job, a force-release is the operator breaking a wedged holder, and
   * a surface that showed all three as "gone" would hide the one worth reading.
   */
  | {
      readonly entity: "claim";
      readonly verb: "deleted";
      readonly claimId: ClaimId;
      readonly workstreamId: WorkstreamId;
      readonly reason: ClaimReleaseReason;
    }
  /**
   * A waitlist place (§3.4): "waiting on a claim is an attention state — a
   * session phase, a health alert past a threshold, and part of blocked-on
   * accounting". `position` and `blockedOnHuman` are derived by the claim
   * manager, never by a surface counting rows.
   */
  | {
      readonly entity: "claim_wait";
      readonly verb: "created" | "updated";
      readonly wait: ClaimWait;
      readonly position: number;
      readonly blockedOnHuman: boolean;
      /** Set when the manager refused this wait to avoid a deadlock (§3.4). */
      readonly refusal: string | null;
    }
  | {
      readonly entity: "claim_wait";
      readonly verb: "deleted";
      readonly waitId: ClaimWaitId;
      readonly workstreamId: WorkstreamId;
      readonly reason: string;
    }
  | {
      readonly entity: "claim_policy";
      readonly verb: "created";
      readonly policy: ClaimPolicy;
      readonly workstreamId: WorkstreamId;
    }
  | {
      readonly entity: "claim_policy";
      readonly verb: "deleted";
      readonly policyId: ClaimPolicyId;
      readonly workstreamId: WorkstreamId;
      readonly reason: string;
    }
  /** A scoped gesture and its state: running, paused, aborted, completed (§4.1). */
  | {
      readonly entity: "run_batch";
      readonly verb: "created" | "updated";
      readonly batch: RunBatch;
    }
  /**
   * One queued run. Published on every state change including the re-ask, which
   * is what makes "a queued run is visible as queued, shows its position, and
   * can be cancelled before it starts" true without polling (§4.1).
   */
  | {
      readonly entity: "run_queue_entry";
      readonly verb: "created" | "updated";
      readonly queued: QueuedRun;
    }
  /**
   * Spend attributed to a session's budgets, its delegates included (§3.6,
   * principle 2). Micros, like every other money value; enforcement is Phase 6's,
   * and this is the number it will enforce against.
   */
  | {
      readonly entity: "session_spend";
      readonly verb: "updated";
      readonly sessionId: SessionId;
      readonly workstreamId: WorkstreamId;
      readonly attributedMicros: number;
      /** How many sessions contributed, own work included. */
      readonly sources: number;
    }
  /**
   * A question raised or answered (§6.4). The whole record travels, options
   * included, because "unpicked options remain visible" is a property of what a
   * surface is given rather than something it fetches separately.
   *
   * `verb` is "created" for a raise and "updated" for an answer; there is no
   * "deleted", because a question that was asked stays asked.
   */
  /**
   * A budget set, raised, lowered, or removed (§8). The whole record travels, so
   * a surface can render the new remaining figure without asking; `verb` is
   * "deleted" for the operator removing a ceiling, which is how §8's "a real
   * number the operator can raise or remove" is spelled.
   */
  | {
      readonly entity: "budget";
      readonly verb: "created" | "updated";
      readonly budget: Budget;
      /** What the scope has spent against it, so the event is readable alone. */
      readonly spentMicros: number;
    }
  | {
      readonly entity: "budget";
      readonly verb: "deleted";
      readonly budgetId: string;
      readonly scope: Budget["scope"];
      readonly workstreamId: WorkstreamId | null;
      readonly reason: string;
    }
  | {
      readonly entity: "session_question";
      readonly verb: "created" | "updated";
      readonly question: SessionQuestion;
      /** Derived: what nobody picked, which stays on the card (§6.4). */
      readonly pathsNotTaken: readonly QuestionOption[];
    }
  /**
   * A session-originated broadcast, for the queue (§6.5: "an agent telling twelve
   * other agents something is exactly the class of event worth knowing
   * happened"). Null `attention` on the operator's own broadcast: their gesture
   * does not need reporting back to them.
   */
  | {
      readonly entity: "broadcast";
      readonly verb: "created";
      readonly broadcastId: string;
      readonly attention: BroadcastAttention | null;
      /** One entry per recipient workstream (§7.3). */
      readonly activity: readonly BroadcastActivityEntry[];
    }
  /**
   * An approval (§6.6), whole: raised (`created`) or answered (`updated`). There
   * is no `deleted` — an approval that was asked stays asked, exactly like a
   * question.
   */
  | {
      readonly entity: "approval";
      readonly verb: "created" | "updated";
      readonly approval: Approval;
      /** Null once answered: the feed ranks what is still asking (§7.1). */
      readonly attention: ApprovalAttention | null;
    }
  | {
      readonly entity: "pre_grant";
      readonly verb: "created" | "deleted";
      readonly preGrant: PreGrant;
    }
  | {
      readonly entity: "attention";
      readonly verb: "created" | "updated";
      readonly item: AttentionItem;
    }
  | {
      readonly entity: "attention";
      readonly verb: "deleted";
      readonly itemId: string;
      /**
       * Why it left: the condition it reported is no longer true, or the
       * operator triaged it away. A subscriber told only "gone" could not tell a
       * snooze from a resolution, and the two read differently to a human.
       */
      readonly reason: "resolved" | "triaged";
    }
  | {
      readonly entity: "notification_route";
      readonly verb: "created" | "updated";
      readonly route: NotificationRoute;
    }
  | {
      readonly entity: "notification_route";
      readonly verb: "deleted";
      readonly routeId: string;
    }
  | {
      readonly entity: "integration";
      readonly verb: "created" | "updated";
      readonly integration: Integration;
    }
  | {
      readonly entity: "integration";
      readonly verb: "deleted";
      readonly integrationId: string;
    };

/** One message on the state-change stream: envelope plus a typed body. */
export type DomainEvent = DomainEventEnvelope & DomainEventBody;

/** What a publisher accepts: everything but the envelope fields it assigns. */
export type DomainEventInput = DomainEventBody & { readonly author: Author };

/** Narrows a `DomainEvent` to those about one entity kind. */
export function isEventFor<E extends EventEntity>(
  event: DomainEvent,
  entity: E,
): event is Extract<DomainEvent, { entity: E }> {
  return event.entity === entity;
}
