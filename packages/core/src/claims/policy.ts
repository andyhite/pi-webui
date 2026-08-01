import type { ClaimId, ClaimPolicyId } from "./ids.js";
import {
  describePath,
  isWithin,
  pathDepth,
  relativeSegments,
  type ClaimPath,
} from "./paths.js";

/**
 * Pre-granted claim policies (§3.4).
 *
 * "A holder can declare policy — _children may claim freely under `src/`; never
 * grant anything under `migrations/`_ — so interactive approval is the
 * exception, not the mechanism. Without this, a twenty-file change costs twenty
 * paid round trips to a parent that must be awake; correct and unusable."
 *
 * A policy is declared *by a claim*: it binds inside that claim's path and dies
 * with it, which is the capability invariant applied to policy — a holder cannot
 * pre-grant reach it does not itself hold.
 */

export type ClaimPolicyEffect = "allow" | "deny";

export interface ClaimPolicy {
  readonly id: ClaimPolicyId;
  /** The claim whose holder declared it. The policy binds inside that claim's path. */
  readonly declaredByClaimId: ClaimId;
  /** Where it applies. Must be within the declaring claim's path. */
  readonly subtree: ClaimPath;
  readonly effect: ClaimPolicyEffect;
  /**
   * Glob over the requested path *relative to* `subtree`. `**` (the default)
   * means the whole subtree including its own path; `*` matches one segment;
   * both are matched case-insensitively, like every other path comparison here.
   */
  readonly pattern: string;
  readonly declaredAt: number;
}

export const MATCH_EVERYTHING = "**";

export type PolicyVerdict =
  | { readonly kind: "allow"; readonly by: ClaimPolicy }
  | { readonly kind: "deny"; readonly by: ClaimPolicy }
  /** No policy said anything: interactive approval is the fallback (§6.6). */
  | { readonly kind: "unstated" };

/**
 * Precedence, stated: **deny wins, at any depth.**
 *
 * A more specific allow does not override a broader deny — "never grant anything
 * under `migrations/`" has to mean it, or the escape hatch becomes a race
 * between rule depths. Among rules of the same effect the deepest subtree is
 * reported, because that is the one worth naming in the message; which one is
 * reported never changes the verdict.
 */
export function evaluatePolicies(
  policies: readonly ClaimPolicy[],
  path: ClaimPath,
): PolicyVerdict {
  let deny: ClaimPolicy | null = null;
  let allow: ClaimPolicy | null = null;

  for (const policy of policies) {
    if (!policyMatches(policy, path)) continue;
    if (policy.effect === "deny") {
      if (deny === null || isMoreSpecific(policy, deny)) deny = policy;
    } else if (allow === null || isMoreSpecific(policy, allow)) {
      allow = policy;
    }
  }

  if (deny) return { kind: "deny", by: deny };
  if (allow) return { kind: "allow", by: allow };
  return { kind: "unstated" };
}

export function policyMatches(policy: ClaimPolicy, path: ClaimPath): boolean {
  if (!isWithin(path, policy.subtree)) return false;
  return globMatches(policy.pattern, relativeSegments(path, policy.subtree));
}

function isMoreSpecific(
  candidate: ClaimPolicy,
  incumbent: ClaimPolicy,
): boolean {
  const byDepth = pathDepth(candidate.subtree) - pathDepth(incumbent.subtree);
  if (byDepth !== 0) return byDepth > 0;
  // A literal pattern is more specific than one with wildcards, and a later
  // declaration breaks a remaining tie so the result never depends on array
  // order (this whole layer is deterministic on purpose).
  const byWildcards =
    wildcardCount(incumbent.pattern) - wildcardCount(candidate.pattern);
  if (byWildcards !== 0) return byWildcards > 0;
  return candidate.declaredAt >= incumbent.declaredAt;
}

function wildcardCount(pattern: string): number {
  return (pattern.match(/[*?]/g) ?? []).length;
}

/**
 * A deliberately small glob: `**` spans any number of segments, `*` and `?` stay
 * inside one. No brace expansion, no character classes, no negation — a pattern
 * language a holder cannot predict is a policy nobody can audit.
 */
export function globMatches(
  pattern: string,
  segments: readonly string[],
): boolean {
  const patternSegments = pattern
    .split("/")
    .filter((segment) => segment.length > 0);
  return matchFrom(patternSegments, 0, segments, 0);
}

function matchFrom(
  pattern: readonly string[],
  patternIndex: number,
  segments: readonly string[],
  segmentIndex: number,
): boolean {
  if (patternIndex === pattern.length) return segmentIndex === segments.length;

  const current = pattern[patternIndex] as string;

  if (current === MATCH_EVERYTHING) {
    for (let skip = segmentIndex; skip <= segments.length; skip += 1) {
      if (matchFrom(pattern, patternIndex + 1, segments, skip)) return true;
    }
    return false;
  }

  if (segmentIndex === segments.length) return false;
  if (!segmentMatches(current, segments[segmentIndex] as string)) return false;
  return matchFrom(pattern, patternIndex + 1, segments, segmentIndex + 1);
}

function segmentMatches(pattern: string, segment: string): boolean {
  const escaped = pattern
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`).test(segment);
}

/** The message a refusal carries, so an agent can act on it rather than retry. */
export function describePolicy(policy: ClaimPolicy): string {
  const scope = describePath(policy.subtree);
  const pattern =
    policy.pattern === MATCH_EVERYTHING ? "" : ` matching ${policy.pattern}`;
  return `${policy.effect} under ${scope}${pattern}`;
}
