import type { Author } from "../author.js";
import type {
  EdgeId,
  NodeId,
  ObjectId,
  SessionId,
  WorkstreamId,
} from "../ids.js";
import type { InjectionContent, InjectionEdge } from "./injection.js";
import { injectionTitle } from "./injection.js";
import type { SessionLaunchChoices } from "./runtime.js";
import type { Transcript } from "./transcript.js";

/**
 * Handoff (§6.3).
 *
 * "A handoff seeds a new session with a brief the source session writes itself
 * and the user edits before sending."
 *
 * Three parties, in one order, and the order is the point: the source session
 * **drafts**, a human **reviews** (editing or not), and only then is the brief
 * **sent**. That sequence is enforced by the types rather than by a check that
 * could be skipped — `planHandoff` accepts a `ReviewedHandoffBrief`, and there is
 * no function that produces one from anything but a human's review. Handing a
 * draft to it is a type error, which `handoff.test.ts` asserts.
 *
 * What a handoff is *not*: a second way to start a session out of nowhere. The
 * new session lives in a workstream that already exists or was created by the
 * ordinary gesture, and the brief becomes ordinary content wired into it — a
 * context edge with the human as its author, because the human is who sent it
 * (§15-2, principle 5).
 */

export type HandoffBriefId = string;

/** Whether the source session wrote it, or PlotRoom extracted one from the log. */
export type HandoffBriefOrigin = "session-written" | "derived";

interface HandoffBriefBase {
  readonly id: HandoffBriefId;
  readonly sourceSessionId: SessionId;
  readonly text: string;
  readonly origin: HandoffBriefOrigin;
  /** Who wrote the draft: the source session, or the product for a derived one. */
  readonly draftedBy: Author | null;
  readonly draftedAt: number;
}

export interface DraftedHandoffBrief extends HandoffBriefBase {
  readonly state: "drafted";
}

export interface ReviewedHandoffBrief extends HandoffBriefBase {
  readonly state: "reviewed";
  /** Always a human: `reviewHandoffBrief` refuses anything else. */
  readonly reviewedBy: Author;
  readonly reviewedAt: number;
  /** Whether the human changed the words, recorded because it is worth knowing. */
  readonly edited: boolean;
  /** The draft as the session wrote it, kept when the human rewrote it. */
  readonly draftText: string;
}

export type HandoffBrief = DraftedHandoffBrief | ReviewedHandoffBrief;

export interface DraftHandoffBriefInput {
  readonly id: HandoffBriefId;
  readonly sourceSessionId: SessionId;
  readonly text: string;
  readonly draftedBy: Author;
  readonly at: number;
}

/** The source session writing its own brief — `plotroom_handoff_brief` (§6.3). */
export function draftHandoffBrief(
  input: DraftHandoffBriefInput,
): DraftedHandoffBrief {
  return {
    state: "drafted",
    id: input.id,
    sourceSessionId: input.sourceSessionId,
    text: input.text,
    origin: "session-written",
    draftedBy: input.draftedBy,
    draftedAt: input.at,
  };
}

/**
 * A brief for a session that never wrote one — an interrupted session, say.
 *
 * Extracted, and labelled as extracted: this is an outline of the record, not a
 * summary of the work. Nothing here paraphrases (there is no model in `core`), so
 * every line is a fact the log already holds: how far it got, which tools it
 * used, and the last thing it said. §13 tracks summarised continuation as a
 * recorded intention; this is deliberately not that.
 */
export function deriveHandoffBrief(input: {
  readonly id: HandoffBriefId;
  readonly transcript: Transcript;
  readonly at: number;
}): DraftedHandoffBrief {
  const turns = input.transcript.turns;
  const tools = new Set<string>();
  let lastOutput: string | null = null;

  for (const turn of turns) {
    for (const entry of turn.entries) {
      if (entry.kind === "tool-call") tools.add(entry.toolName);
      if (entry.kind === "output" && entry.text.trim().length > 0) {
        lastOutput = entry.text.trim();
      }
    }
  }

  const lines = [
    "This brief was derived from the source session's own record, not written by it.",
    "",
    `Turns: ${turns.length}`,
    `Tools used: ${tools.size === 0 ? "none" : [...tools].sort().join(", ")}`,
    "",
    "Last thing the session said:",
    lastOutput ?? "(it produced no output)",
  ];

  return {
    state: "drafted",
    id: input.id,
    sourceSessionId: input.transcript.sessionId,
    text: lines.join("\n"),
    origin: "derived",
    // Nobody authored a derivation. `Author` has no system variant, and inventing
    // one here would let an unattributed author leak into the graph (§15-2).
    draftedBy: null,
    draftedAt: input.at,
  };
}

export const HANDOFF_REFUSAL_REASONS = [
  /** A session reviewing the brief it wrote is the review not happening (§6.3). */
  "human_only",
  /** Already reviewed: reviewing twice would overwrite what was approved. */
  "already_reviewed",
  /** An empty brief seeds a session with nothing; that is not a handoff. */
  "empty_brief",
] as const;

export type HandoffRefusalReason = (typeof HANDOFF_REFUSAL_REASONS)[number];

export interface HandoffRefusal {
  readonly reason: HandoffRefusalReason;
  readonly message: string;
}

export type HandoffResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: HandoffRefusal };

export interface ReviewHandoffBriefInput {
  /** The text as the human wants it sent; omit to send the draft unchanged. */
  readonly text?: string;
  readonly by: Author;
  readonly at: number;
}

/**
 * The human's review. The **only** producer of a `ReviewedHandoffBrief`, which is
 * what makes "the user edits before sending" a property of the type rather than a
 * step someone remembered.
 */
export function reviewHandoffBrief(
  brief: HandoffBrief,
  input: ReviewHandoffBriefInput,
): HandoffResult<ReviewedHandoffBrief> {
  if (brief.state === "reviewed") {
    return {
      ok: false,
      refusal: {
        reason: "already_reviewed",
        message:
          "this brief was already reviewed; draft a new one to change it",
      },
    };
  }
  if (input.by.kind !== "human") {
    return {
      ok: false,
      refusal: {
        reason: "human_only",
        message:
          "a handoff brief is reviewed by the user before it is sent; a session approving its own brief is the review not happening (§6.3)",
      },
    };
  }

  const text = (input.text ?? brief.text).trim();
  if (text.length === 0) {
    return {
      ok: false,
      refusal: {
        reason: "empty_brief",
        message: "an empty brief seeds the new session with nothing to go on",
      },
    };
  }

  return {
    ok: true,
    value: {
      ...brief,
      state: "reviewed",
      text,
      draftText: brief.text,
      edited: text !== brief.text.trim(),
      reviewedBy: input.by,
      reviewedAt: input.at,
    },
  };
}

export interface HandoffIds {
  readonly sessionId: SessionId;
  readonly objectId: ObjectId;
  /** The node the brief content gets on the board. */
  readonly nodeId: NodeId;
  readonly edgeId: EdgeId;
}

export interface HandoffRequest {
  readonly ids: HandoffIds;
  /** Where the new session runs. An existing workstream, or one just created. */
  readonly workstreamId: WorkstreamId;
  /** The new session's node, so the brief can be wired into it (§3.7). */
  readonly targetNodeId: NodeId;
  readonly launch: SessionLaunchChoices;
  readonly ordinal: number;
  readonly at: number;
}

export interface HandoffPlan {
  readonly sourceSessionId: SessionId;
  readonly briefId: HandoffBriefId;
  /** The brief as permanent graph content (principle 5). */
  readonly content: InjectionContent;
  /** Wired into the new session, authored by the human who sent it (§15-2). */
  readonly edge: InjectionEdge;
  readonly session: {
    readonly id: SessionId;
    readonly workstreamId: WorkstreamId;
    readonly launch: SessionLaunchChoices;
    readonly initiatedBy: Author;
  };
  readonly provenance: {
    readonly relation: "session_handoff";
    readonly fromSessionId: SessionId;
    readonly toSessionId: SessionId;
    readonly recordedAt: number;
  };
  readonly at: number;
}

/**
 * Plan the send. The signature is the enforcement: a `DraftedHandoffBrief` does
 * not typecheck here, so an unreviewed brief cannot reach a new session.
 */
export function planHandoff(
  brief: ReviewedHandoffBrief,
  request: HandoffRequest,
): HandoffPlan {
  return {
    sourceSessionId: brief.sourceSessionId,
    briefId: brief.id,
    content: {
      objectId: request.ids.objectId,
      nodeId: request.ids.nodeId,
      kind: "note",
      scope: "local",
      title: `handoff: ${injectionTitle(brief.text)}`,
      body: brief.text,
      createdAt: request.at,
    },
    edge: {
      id: request.ids.edgeId,
      kind: "context",
      from: request.ids.nodeId,
      to: request.targetNodeId,
      // The reviewer is the author, not the drafting session: the human decided
      // this session should know this, which is exactly what §15-2 records.
      author: brief.reviewedBy,
      ordinal: request.ordinal,
      createdAt: request.at,
    },
    session: {
      id: request.ids.sessionId,
      workstreamId: request.workstreamId,
      launch: request.launch,
      initiatedBy: brief.reviewedBy,
    },
    provenance: {
      relation: "session_handoff",
      fromSessionId: brief.sourceSessionId,
      toSessionId: request.ids.sessionId,
      recordedAt: request.at,
    },
    at: request.at,
  };
}
