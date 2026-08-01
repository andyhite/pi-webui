import type { Author } from "../../author.js";
import { describeAsk, type ApprovalAsk } from "./ask.js";
import type { Approval } from "./approval.js";
import {
  describePreGrant,
  evaluatePreGrants,
  preGrantable,
  preGrantPiercedBy,
  type PiercedPreGrant,
  type PreGrant,
  type PreGrantSubject,
} from "./pre-grants.js";

/**
 * The one approval decision (§6.6, principle 8).
 *
 * Every surface that could raise an approval asks this: the write gate
 * (`decideToolPermission`), a destruction-class tool call (`decideDestruction`),
 * and — when Track A wires it — a claim wait with no covering policy. A second
 * implementation is exactly what principle 8 exists to prevent, and here it would
 * be worse than a divergence: two evaluators means one of them ends up the one
 * that forgot §6.6's piercing rule.
 *
 * The order is the whole rule, and it is short:
 *
 * 1. **A human is never gated.** §6.6 is about "a session requesting a capability
 *    it does not have". The operator is the authority every chain terminates at.
 * 2. **An answered approval settles it** — approve once, or deny with its reason.
 * 3. **`preGrantable` or ask.** The only route to pre-grant evaluation is through a
 *    constructor that returns `null` for an irreversible ask, so step 4 is
 *    unreachable for one. That is "irreversibility pierces pre-grants", spelled as
 *    a type rather than as a branch someone could reorder.
 * 4. **Deny wins, then allow, then the ask's own trigger decides.** An ask nothing
 *    would have raised (`trigger: "none"`) is allowed when no pre-grant denied it;
 *    anything else asks.
 */
export type ApprovalAuthority =
  /** The operator acted; §6.6 gates sessions, not humans. */
  | { readonly kind: "human" }
  /** An approval was raised and answered (§6.6). */
  | { readonly kind: "approval"; readonly approvalId: Approval["id"] }
  /** A standing decision made in advance covered it — silent, and logged. */
  | { readonly kind: "pre-grant"; readonly preGrantId: PreGrant["id"] }
  /** Nothing gates it: a read, or a bounded write claims already answered (§3.4). */
  | { readonly kind: "not-gated" };

export type ApprovalVerdict =
  | {
      readonly kind: "allowed";
      readonly by: ApprovalAuthority;
      /** Why, in a sentence — the log line for a silent allow (§6.6). */
      readonly reason: string;
    }
  | {
      readonly kind: "must-ask";
      /** Hand this to `raiseApproval`; it is the record's whole content. */
      readonly ask: ApprovalAsk;
      readonly pierced: PiercedPreGrant | null;
      readonly reason: string;
    }
  | {
      readonly kind: "denied";
      readonly by: ApprovalAuthority;
      /** Feedback the session acts on, never a bare failure (§6.6). */
      readonly reason: string;
    };

export interface ApprovalContext extends PreGrantSubject {
  readonly actor: Author;
  readonly preGrants?: readonly PreGrant[];
  /**
   * An approval already raised for *this* gesture, answered or not. An unanswered
   * one produces `must-ask` again rather than an allow — a raise is not an answer,
   * and a caller that treated a pending approval as permission would have inverted
   * the whole mechanism.
   */
  readonly approval?: Approval | null;
}

export function decideApproval(
  ask: ApprovalAsk,
  context: ApprovalContext,
): ApprovalVerdict {
  if (context.actor.kind === "human") {
    return {
      kind: "allowed",
      by: { kind: "human" },
      reason:
        "the operator acted; §6.6 gates a session requesting capability, never the human every chain terminates at",
    };
  }

  const raised = context.approval ?? null;
  const answered = raised?.answer ?? null;
  if (raised !== null && answered !== null) {
    if (answered.decision === "approve-once") {
      return {
        kind: "allowed",
        by: { kind: "approval", approvalId: raised.id },
        reason: `approved once by the operator: ${describeAsk(ask)}`,
      };
    }
    return {
      kind: "denied",
      by: { kind: "approval", approvalId: raised.id },
      reason:
        answered.reason ??
        "declined by the operator; this is feedback about how to proceed, not a failure (§6.6)",
    };
  }

  const preGrants = context.preGrants ?? [];

  // §6.6, structurally: there is no `PreGrantableAsk` for an irreversible ask, so
  // the pre-grants below are unreachable for one. The pierced rule is named in the
  // raise rather than silently ignored.
  const grantable = preGrantable(ask);
  if (grantable === null) {
    const pierced = preGrantPiercedBy(preGrants, ask, context);
    return {
      kind: "must-ask",
      ask,
      pierced,
      reason:
        pierced === null
          ? `${describeAsk(ask)} cannot be undone, so it asks (§6.6, §9.2)`
          : `${describeAsk(ask)} cannot be undone, so it asks even though ${pierced.description} would otherwise have covered it (§6.6)`,
    };
  }

  const verdict = evaluatePreGrants(preGrants, grantable, context);
  if (verdict.kind === "deny") {
    return {
      kind: "denied",
      by: { kind: "pre-grant", preGrantId: verdict.by.id },
      reason: `refused by a standing decision: ${describePreGrant(verdict.by)}`,
    };
  }
  if (verdict.kind === "allow") {
    return {
      kind: "allowed",
      by: { kind: "pre-grant", preGrantId: verdict.by.id },
      reason: `pre-granted in advance: ${describePreGrant(verdict.by)}`,
    };
  }

  if (ask.trigger === "none") {
    return {
      kind: "allowed",
      by: { kind: "not-gated" },
      reason: `nothing about ${describeAsk(ask)} raises an approval; claims answer the write itself (§3.4)`,
    };
  }

  return {
    kind: "must-ask",
    ask,
    pierced: null,
    reason: `${describeAsk(ask)} needs an approval (${ask.trigger}); nothing pre-granted covers it (§6.6)`,
  };
}
