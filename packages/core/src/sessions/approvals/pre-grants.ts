import type { Author } from "../../author.js";
import { globMatches, MATCH_EVERYTHING } from "../../claims/policy.js";
import type { SessionId, WorkstreamId } from "../../ids.js";
import {
  isIrreversibleAsk,
  type ApprovalAsk,
  type ApprovalKind,
  type ApprovalWriteExtent,
} from "./ask.js";
import type { PreGrantId } from "./ids.js";

/**
 * Pre-grants (§6.6).
 *
 * "Approvals can be **pre-granted** per session or per workstream — a human
 * decision about capability made in advance, which is different in kind from a
 * timer that spends."
 *
 * That sentence is the whole design brief, and both halves of it are enforced:
 *
 * - **A human decision.** `declarePreGrant` refuses a session author outright.
 *   There is no path by which a chain grants itself capability (principle 1), and
 *   no "approve always" answer on an approval either — a durable grant is its own
 *   gesture, made by the operator, and `answerApproval` cannot produce one.
 * - **Made in advance, not by a clock.** A pre-grant has no expiry, no window, and
 *   no "after n minutes" field. It is withdrawn by a human or it stands. A
 *   pre-grant that lapsed on a timer would be the system changing what an agent
 *   may do with nobody behind it, which is the shape principle 2 rules out.
 *
 * ## Deliberately not a claim policy
 *
 * `ClaimPolicy` (§3.4) pre-grants **paths inside a claim someone holds**, and dies
 * with that claim. A pre-grant here is about **capability**: which tools, at which
 * write extent, for which session or workstream. The two are not one table with a
 * flag because they answer different questions and are bounded by different things
 * — and, load-bearing: a pre-grant never pierces a claim. Isolation is a guarantee
 * (principle 4), so an allowed pre-grant means *no approval is needed*, never
 * *skip the claim check*; `decideToolPermission` still asks the claim manager
 * about every path.
 *
 * The **glob language is shared** with claim policies (`globMatches`), so an
 * operator learns one pattern syntax: `*` inside one segment, `**` for everything.
 * A tool name is matched as a single segment.
 */

export type PreGrantEffect = "allow" | "deny";

/**
 * Who the grant is for. Two scopes, exactly as §6.6 names them, and no third:
 * a global "always allow this tool" would be a product-wide capability nobody
 * attached to any work, and there is no surface on which it could be reviewed.
 */
export type PreGrantScope =
  | { readonly kind: "session"; readonly sessionId: SessionId }
  | { readonly kind: "workstream"; readonly workstreamId: WorkstreamId };

export interface PreGrant {
  readonly id: PreGrantId;
  readonly scope: PreGrantScope;
  readonly effect: PreGrantEffect;
  /**
   * Which classes of ask it speaks to. Named explicitly rather than defaulted to
   * all of them: "let this session write files" and "let this session delete my
   * workstreams" are not the same decision, and a pre-grant that covered every
   * kind because its author left a field out would be the second one by accident.
   */
  readonly kinds: readonly ApprovalKind[];
  /** Glob over the tool name; `**` for any tool, including a gesture with none. */
  readonly toolPattern: string;
  /**
   * Which write extents it covers. `"unbounded"` has to be named — a pattern over
   * tool names does not silently pre-grant a shell, because the whole reason an
   * unbounded extent raises is that nobody could say what it would write.
   */
  readonly extents: readonly ApprovalWriteExtent[];
  /** Always a human (principle 1); `declarePreGrant` is what enforces it. */
  readonly grantedBy: Author;
  readonly grantedAt: number;
  /** Withdrawn by a human. Retired rather than deleted, like a claim row. */
  readonly withdrawnAt: number | null;
}

export const ALL_APPROVAL_EXTENTS: readonly ApprovalWriteExtent[] = [
  "none",
  "paths",
  "unbounded",
];

/**
 * An ask a pre-grant is *allowed to be evaluated against*.
 *
 * This brand is how "irreversibility pierces pre-grants" stops being a rule
 * someone has to remember. `evaluatePreGrants` takes a `PreGrantableAsk`, and the
 * only way to obtain one is {@link preGrantable}, which returns `null` for an
 * irreversible ask. So a coverage verdict for an irreversible ask is not something
 * the code refuses at runtime — it is something no call site can write down.
 * `pre-grants.test.ts` asserts the `@ts-expect-error`, which is what keeps it
 * structural rather than incidental.
 *
 * A **proposal** (§3.8's `standing-instruction` kind) is the second thing it returns
 * `null` for, and for a reason of the same shape: "the agent proposes and a human
 * accepts; a proposal is confirmed, never applied silently" (principle 1). An
 * "allow always" covering proposals would apply them silently, so there must be no
 * expression of coverage for one anywhere.
 */
declare const preGrantableBrand: unique symbol;

export type PreGrantableAsk = ApprovalAsk & {
  readonly [preGrantableBrand]: "PreGrantableAsk";
};

/**
 * The only constructor of a {@link PreGrantableAsk} — and the single statement of
 * §6.6's piercing rule.
 *
 * `null` means the ask can never be covered by anything declared in advance, so
 * the caller's only move is to raise an approval. Not "should not": cannot.
 */
export function preGrantable(ask: ApprovalAsk): PreGrantableAsk | null {
  if (isIrreversibleAsk(ask)) return null;
  if (isProposalAsk(ask)) return null;
  return ask as PreGrantableAsk;
}

/**
 * Whether this ask is a proposal, in one place so the refusal below and the
 * coverage gate above cannot disagree about which kind that is (principle 8).
 */
export function isProposalAsk(ask: ApprovalAsk): boolean {
  return ask.kind === "standing-instruction";
}

export type PreGrantVerdict =
  | { readonly kind: "allow"; readonly by: PreGrant }
  | { readonly kind: "deny"; readonly by: PreGrant }
  /** Nothing declared in advance speaks to this ask; §6.6's approval is the fallback. */
  | { readonly kind: "unstated" };

export interface PreGrantSubject {
  readonly sessionId: SessionId;
  /**
   * Null for a caller that does not know which workstream binds — under which a
   * workstream-scoped grant matches **nothing**. That is the safe reading: an
   * unknown scope must not silently satisfy a scope check, and the alternative
   * (a sentinel id) would have been an id that could collide.
   */
  readonly workstreamId: WorkstreamId | null;
}

/**
 * Precedence, stated: **deny wins, at any scope.**
 *
 * The same rule as `evaluatePolicies` (§3.4) and for the same reason: a narrower
 * allow overriding a broader deny turns "never let it merge" into a race between
 * rule specificity, and the operator loses that race in the one case they wrote
 * the rule for. A session-scoped allow therefore does **not** beat a
 * workstream-scoped deny.
 *
 * Specificity decides only which matching rule is *reported* — session before
 * workstream, literal before wildcard, later declaration last — because a message
 * naming the vaguest matching rule sends the operator hunting. It never changes
 * the verdict.
 */
export function evaluatePreGrants(
  preGrants: readonly PreGrant[],
  ask: PreGrantableAsk,
  subject: PreGrantSubject,
): PreGrantVerdict {
  let deny: PreGrant | null = null;
  let allow: PreGrant | null = null;

  for (const preGrant of preGrants) {
    if (!preGrantMatches(preGrant, ask, subject)) continue;
    if (preGrant.effect === "deny") {
      if (deny === null || isMoreSpecific(preGrant, deny)) deny = preGrant;
    } else if (allow === null || isMoreSpecific(preGrant, allow)) {
      allow = preGrant;
    }
  }

  if (deny !== null) return { kind: "deny", by: deny };
  if (allow !== null) return { kind: "allow", by: allow };
  return { kind: "unstated" };
}

export function preGrantMatches(
  preGrant: PreGrant,
  ask: ApprovalAsk,
  subject: PreGrantSubject,
): boolean {
  if (preGrant.withdrawnAt !== null) return false;
  if (!inScope(preGrant.scope, subject)) return false;
  if (!preGrant.kinds.includes(ask.kind)) return false;
  if (!preGrant.extents.includes(ask.writeExtent)) return false;
  return globMatches(preGrant.toolPattern, [(ask.tool ?? "").toLowerCase()]);
}

function inScope(scope: PreGrantScope, subject: PreGrantSubject): boolean {
  if (scope.kind === "session") return scope.sessionId === subject.sessionId;
  return (
    subject.workstreamId !== null && scope.workstreamId === subject.workstreamId
  );
}

function isMoreSpecific(candidate: PreGrant, incumbent: PreGrant): boolean {
  const byScope = scopeRank(candidate.scope) - scopeRank(incumbent.scope);
  if (byScope !== 0) return byScope > 0;
  const byWildcards =
    wildcardCount(incumbent.toolPattern) - wildcardCount(candidate.toolPattern);
  if (byWildcards !== 0) return byWildcards > 0;
  const byKinds = incumbent.kinds.length - candidate.kinds.length;
  if (byKinds !== 0) return byKinds > 0;
  return candidate.grantedAt >= incumbent.grantedAt;
}

function scopeRank(scope: PreGrantScope): number {
  return scope.kind === "session" ? 1 : 0;
}

function wildcardCount(pattern: string): number {
  return (pattern.match(/[*?]/g) ?? []).length;
}

export const PRE_GRANT_REFUSAL_REASONS = [
  /**
   * A session declaring a pre-grant. "A human decision about capability made in
   * advance" (§6.6) — a session declaring one would grant itself capability,
   * which principle 1 forbids however many steps it takes to get there.
   */
  "human_only",
  /** No kinds, or no extents: a pre-grant that covers nothing is a typo. */
  "covers_nothing",
  /**
   * The declaration names an irreversible write. Refused rather than accepted and
   * ignored, so an operator is never left believing a merge was pre-approved. The
   * *evaluation* is already structurally incapable of covering one; this is the
   * message that says why (§6.6).
   */
  "irreversible_not_pre_grantable",
  /**
   * The declaration names the proposal kind. Refused for the same reason and with
   * the same shape: `preGrantable` can never produce a coverage check for one, so a
   * grant that named it would read as "proposals are pre-approved" and behave as
   * absent — and a proposal applied without being confirmed is precisely what
   * principle 1 forbids (§3.8).
   */
  "proposals_not_pre_grantable",
] as const;

export type PreGrantRefusalReason = (typeof PRE_GRANT_REFUSAL_REASONS)[number];

export interface PreGrantRefusal {
  readonly reason: PreGrantRefusalReason;
  readonly message: string;
}

export type PreGrantResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: PreGrantRefusal };

export interface DeclarePreGrantInput {
  readonly id: PreGrantId;
  readonly scope: PreGrantScope;
  readonly effect: PreGrantEffect;
  readonly kinds: readonly ApprovalKind[];
  readonly toolPattern?: string;
  readonly extents?: readonly ApprovalWriteExtent[];
  readonly by: Author;
  readonly at: number;
  /**
   * Optional: the ask the operator is generalizing from ("allow this, and ones
   * like it"). Supplied, it is checked — an irreversible ask is refused with the
   * reason, rather than producing a grant that would never fire.
   */
  readonly generalizing?: ApprovalAsk;
}

export function declarePreGrant(
  input: DeclarePreGrantInput,
): PreGrantResult<PreGrant> {
  if (input.by.kind !== "human") {
    return {
      ok: false,
      refusal: {
        reason: "human_only",
        message:
          "a pre-grant is a human decision about capability made in advance; a session declaring one would grant itself capability (§6.6, principle 1)",
      },
    };
  }
  const extents = input.extents ?? ALL_APPROVAL_EXTENTS;
  if (input.kinds.length === 0 || extents.length === 0) {
    return {
      ok: false,
      refusal: {
        reason: "covers_nothing",
        message:
          "a pre-grant must name at least one kind of ask and one write extent; one that covers nothing would read as granted and behave as absent",
      },
    };
  }
  if (
    input.kinds.includes("standing-instruction") ||
    (input.generalizing !== undefined && isProposalAsk(input.generalizing))
  ) {
    return {
      ok: false,
      refusal: {
        reason: "proposals_not_pre_grantable",
        message:
          "a proposal is confirmed by a human, never applied silently, so it cannot be pre-granted — accepting one is the gesture (§3.8, principle 1)",
      },
    };
  }
  if (
    input.effect === "allow" &&
    input.generalizing !== undefined &&
    isIrreversibleAsk(input.generalizing)
  ) {
    return {
      ok: false,
      refusal: {
        reason: "irreversible_not_pre_grantable",
        message:
          "an irreversible write always raises an approval regardless of what was pre-granted, so it cannot be pre-granted (§6.6, §9.2)",
      },
    };
  }

  return {
    ok: true,
    value: {
      id: input.id,
      scope: input.scope,
      effect: input.effect,
      kinds: input.kinds,
      toolPattern: input.toolPattern ?? MATCH_EVERYTHING,
      extents,
      grantedBy: input.by,
      grantedAt: input.at,
      withdrawnAt: null,
    },
  };
}

/** Withdrawn by a human, and retired rather than removed: it happened. */
export function withdrawPreGrant(
  preGrant: PreGrant,
  by: Author,
  at: number,
): PreGrantResult<PreGrant> {
  if (by.kind !== "human") {
    return {
      ok: false,
      refusal: {
        reason: "human_only",
        message:
          "withdrawing a pre-grant is the operator's; a session narrowing or widening its own capability is principle 1 either way",
      },
    };
  }
  if (preGrant.withdrawnAt !== null) return { ok: true, value: preGrant };
  return { ok: true, value: { ...preGrant, withdrawnAt: at } };
}

/** The message a refusal or a silent allow carries, so both name the same rule. */
export function describePreGrant(preGrant: PreGrant): string {
  const scope =
    preGrant.scope.kind === "session"
      ? `session ${preGrant.scope.sessionId}`
      : `workstream ${preGrant.scope.workstreamId}`;
  const tools =
    preGrant.toolPattern === MATCH_EVERYTHING
      ? "any tool"
      : `tools matching ${preGrant.toolPattern}`;
  return `${preGrant.effect} ${tools} for ${scope} (${preGrant.kinds.join(", ")}; extents ${preGrant.extents.join(", ")})`;
}

/**
 * The pre-grant that **would** have covered this ask, for an approval that was
 * raised anyway because it is irreversible (§6.6).
 *
 * The return type is deliberately not a verdict and carries no `PreGrant`: it is a
 * description, so there is nothing here to feed to a call site that allows things.
 * It exists because "this was pre-granted and asked anyway" is the one sentence
 * that stops the operator reading the raise as a bug in their own configuration.
 */
export interface PiercedPreGrant {
  readonly preGrantId: PreGrantId;
  readonly description: string;
}

export function preGrantPiercedBy(
  preGrants: readonly PreGrant[],
  ask: ApprovalAsk,
  subject: PreGrantSubject,
): PiercedPreGrant | null {
  if (!isIrreversibleAsk(ask)) return null;
  let found: PreGrant | null = null;
  for (const preGrant of preGrants) {
    if (preGrant.effect !== "allow") continue;
    if (!preGrantMatches(preGrant, ask, subject)) continue;
    if (found === null || isMoreSpecific(preGrant, found)) found = preGrant;
  }
  if (found === null) return null;
  return { preGrantId: found.id, description: describePreGrant(found) };
}
