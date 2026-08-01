import type { SessionId, WorkstreamId } from "../../ids.js";
import type { WriteIntent } from "../tools/gate.js";
import type {
  ToolWorldDeclaration,
  WriteReversibility,
} from "../outside-world.js";
import { isIrreversibleWrite } from "../outside-world.js";

/**
 * What is being asked (§6.6), as a structure rather than a sentence.
 *
 * "A session requesting a capability it does not have — a command to run, a write
 * to an external system, a claim outside every standing policy — raises an
 * **approval**, surfaced on every in-app attention surface and routed outbound
 * (§7.3), answerable without opening the session."
 *
 * Answerable without opening the session is the constraint that shapes this type:
 * everything a human needs in order to answer has to be *in the row*. A row that
 * said "session sess_x wants permission" would send the operator to the transcript
 * to find out what for, which is the same as not being answerable in place. So the
 * ask carries the tool, a one-line summary of its input, the write extent, and the
 * reversibility declaration — the four facts the answer actually turns on.
 *
 * ## One vocabulary for two raise paths
 *
 * Approvals already existed in two shapes before this module: a **claim wait**
 * with no covering policy (§3.4 — `claimWaitReason` returns `"approval"`), and a
 * **write-gate raise** for a tool whose write extent nothing declared
 * (`decideToolPermission`). They are the same event to the operator, so they are
 * one record here with a `kind`, and the attention feed renders one row shape
 * (§7.1). The kinds are not four subsystems; they are four things a session can
 * be asking for.
 */
export const APPROVAL_KINDS = [
  /** A tool call the write gate could not answer from claims alone. */
  "tool-permission",
  /** A claim outside every standing policy (§3.4's `approval` wait reason). */
  "claim",
  /** A session destroying authored state (§6.6, principle 10). */
  "destruction",
  /** A write to an external system, whose reversibility is declared (§9.2). */
  "integration-write",
] as const;

export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/**
 * How far the call may write, mirroring {@link WriteIntent}'s own three cases so
 * the gate's answer and the approval's record cannot describe one call
 * differently.
 */
export const APPROVAL_WRITE_EXTENTS = ["none", "paths", "unbounded"] as const;

export type ApprovalWriteExtent = (typeof APPROVAL_WRITE_EXTENTS)[number];

/**
 * Why this ask exists at all — what would raise it if nothing were pre-granted.
 *
 * `"none"` is a real member and carries weight: it says *nothing would have
 * raised this*, and it is what makes a pre-granted **deny** able to bite a call
 * that would otherwise never have asked. An operator who declares "this session
 * never calls `github_merge_pr`" has stated a capability, not answered a question,
 * and a deny that only applied to calls already being asked about would be a
 * prohibition with a hole in exactly the shape of everything allowed.
 */
export const APPROVAL_TRIGGERS = [
  /** Nothing raises it: a read, or a bounded write claims already answered. */
  "none",
  /** §6.6: an irreversible write always asks. Never coverable — see `preGrantable`. */
  "irreversible-write",
  /**
   * A declared write to an external system that **is** reversible (§9.2): it asks
   * unless a pre-grant covers it.
   *
   * This is a distinct trigger rather than `"none"` because §6.6 lists "a write to
   * an external system" among the things a session raises an approval for, and §9.2
   * makes every write action available as an agent tool "subject to approvals". The
   * piercing clause presupposes it: if reversible external writes were ungated, then
   * "irreversibility pierces pre-grants" would pierce nothing, because an
   * `integration-write` pre-grant would have had nothing to authorize.
   *
   * Its extent is beside the point. An external write usually writes no workspace
   * path at all, so the claim gate has nothing to say about it (§3.4 governs paths),
   * and reading a `none` extent as "nothing to check" is what left the hole.
   */
  "external-write",
  /** The gate could not bound the write extent, so nothing checked it (§3.4). */
  "undeclared-write-extent",
  /** No standing policy covers it — the claim-wait reason, in this vocabulary. */
  "outside-policy",
  /** A session destroying authored state (§6.6, principle 10). */
  "destruction",
] as const;

export type ApprovalTrigger = (typeof APPROVAL_TRIGGERS)[number];

/**
 * The outside-world half of an ask, present only when a declaration said so.
 *
 * Absent is not the same as `local`, exactly as in `ToolWorldDeclaration`: a tool
 * nobody declared costs certainty about fork cleanliness (§6.3), which
 * `deriveOutsideWorldMarkers` already reports as `unknown`.
 */
export interface ApprovalWorldWrite {
  readonly system: string;
  readonly action: string;
  readonly reversibility: WriteReversibility;
}

export interface ApprovalAsk {
  readonly kind: ApprovalKind;
  readonly trigger: ApprovalTrigger;
  /** The tool being called, or null for a gesture with no tool (a claim). */
  readonly tool: string | null;
  /**
   * One line describing the input — already redacted by whoever built the ask,
   * because this is what goes out over a notification route (§7.3) and
   * credentials are exposed to nothing (§9.3).
   */
  readonly summary: string;
  readonly writeExtent: ApprovalWriteExtent;
  /** The paths the call declared, when it declared any. */
  readonly paths: readonly string[];
  /** Null when no declaration says this touches the outside world. */
  readonly world: ApprovalWorldWrite | null;
  /** The authored record a destruction ask would remove, for a `destruction` ask. */
  readonly target: ApprovalTarget | null;
}

/** What a destruction ask would destroy: the kind and the id, so a row can name it. */
export interface ApprovalTarget {
  readonly kind: string;
  readonly id: string;
}

/**
 * The reversibility of an ask, in one place so no call site re-derives it.
 *
 * An ask with no outside-world declaration has no reversibility *question*: the
 * write gate and claims answer it (§3.4), and §6.6's rule is written about
 * declared write actions. Reporting such an ask as `"unknown"` and therefore
 * always asking would raise an approval for every ordinary file read, which is
 * not a stricter product — it is a product that cannot run, and an operator who
 * approves a hundred reads an hour is not reading any of them.
 *
 * What *is* treated as irreversible is a declaration that says so and a
 * declaration that says `"unknown"` (principle 7): a plugin author who could not
 * tell must not have that read as "reversible". The gap the absent declaration
 * leaves is reported where it is honest to report it — `undeclared` calls in the
 * outside-world markers, and `"unbounded"` write extents, which raise on their own.
 */
export function askReversibility(ask: ApprovalAsk): WriteReversibility | null {
  return ask.world?.reversibility ?? null;
}

/** True when §6.6's piercing rule applies: irreversible, or declared unknown. */
export function isIrreversibleAsk(ask: ApprovalAsk): boolean {
  const reversibility = askReversibility(ask);
  return reversibility !== null && isIrreversibleWrite(reversibility);
}

/** The sentence a queue row, a notification, and a transcript entry all use. */
export function describeAsk(ask: ApprovalAsk): string {
  const subject = ask.tool ?? ask.kind;
  const parts: string[] = [ask.summary.trim() || subject];
  if (ask.world !== null) {
    parts.push(
      `${ask.world.action} on ${ask.world.system} (${ask.world.reversibility})`,
    );
  }
  if (ask.writeExtent === "unbounded") {
    parts.push("could write anywhere");
  } else if (ask.paths.length > 0) {
    parts.push(`writes ${ask.paths.join(", ")}`);
  }
  if (ask.target !== null) {
    parts.push(`removes ${ask.target.kind} ${ask.target.id}`);
  }
  return parts.join(" — ");
}

export interface BuildToolAskInput {
  readonly toolName: string;
  readonly summary: string;
  readonly intent: WriteIntent;
  /** Null for a tool nobody declared — deliberately not read as `local`. */
  readonly world: ToolWorldDeclaration | null;
}

/**
 * Build the ask for one tool call, which is where the gate's two axes meet.
 *
 * The kind follows the declaration rather than the tool's name: a declared
 * outside-world write is an `integration-write` whatever it is called, and that
 * is what carries the reversibility §6.6 pierces pre-grants over.
 */
export function toolCallAsk(input: BuildToolAskInput): ApprovalAsk {
  const world =
    input.world !== null && input.world.kind === "outside-world"
      ? {
          system: input.world.system,
          action: input.world.action,
          reversibility: input.world.reversibility,
        }
      : null;
  const writeExtent: ApprovalWriteExtent = input.intent.kind;
  const paths = input.intent.kind === "paths" ? input.intent.paths : [];
  const irreversible =
    world !== null && isIrreversibleWrite(world.reversibility);

  return {
    kind: world === null ? "tool-permission" : "integration-write",
    // Ordered most-specific-first. A declared external write that is *also*
    // unbounded in the workspace reports `external-write`, the more specific fact;
    // both trigger the same must-ask, and coverage is unaffected either way because
    // a pre-grant has to name the ask's extent as well as its kind.
    trigger: irreversible
      ? "irreversible-write"
      : world !== null
        ? "external-write"
        : writeExtent === "unbounded"
          ? "undeclared-write-extent"
          : "none",
    tool: input.toolName,
    summary: input.summary,
    writeExtent,
    paths,
    world,
    target: null,
  };
}

/** The ask behind a claim wait nothing pre-granted (§3.4's `approval` reason). */
export function claimAsk(input: {
  readonly path: string;
  readonly summary: string;
}): ApprovalAsk {
  return {
    kind: "claim",
    trigger: "outside-policy",
    tool: null,
    summary: input.summary,
    writeExtent: "paths",
    paths: [input.path],
    world: null,
    target: null,
  };
}

/**
 * The ask behind a session destroying authored state (§6.6, principle 10).
 *
 * Reversible by construction, and that is not a loophole: every one of these is a
 * soft delete with an inverse (`SoftDeleteState`), so §6.6's piercing rule has
 * nothing to pierce here. It still always asks — `trigger` is `"destruction"`,
 * never `"none"` — because an operator who never declared a pre-grant is asked
 * before their arrangement is taken apart.
 */
export function destructionAsk(input: {
  readonly toolName: string;
  readonly target: ApprovalTarget;
  readonly summary?: string | undefined;
}): ApprovalAsk {
  return {
    kind: "destruction",
    trigger: "destruction",
    tool: input.toolName,
    summary:
      input.summary ??
      `${input.toolName} on ${input.target.kind} ${input.target.id}`,
    writeExtent: "none",
    paths: [],
    world: null,
    target: input.target,
  };
}

/** Where an ask came from, carried so a raised approval knows what it blocks. */
export interface ApprovalSubject {
  readonly sessionId: SessionId;
  readonly workstreamId: WorkstreamId;
}
