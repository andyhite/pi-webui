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
  CommandDefinition,
  CommandNode,
  CommandOutput,
} from "./commands.js";
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
import type { Run } from "./runs.js";
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
