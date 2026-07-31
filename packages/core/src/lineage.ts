import type { Author } from "./author.js";
import type { SessionId } from "./ids.js";

/**
 * The initiation chain (spec principle 1, §2.8).
 *
 * Every running session's chain terminates at a human gesture, however many
 * agent decisions sit in between. `initiatedBy` is the session that started
 * this one, or null when a human did.
 */
export interface Lineage {
  readonly sessionId: SessionId;
  readonly initiatedBy: SessionId | null;
}

export interface LineageIndex {
  parentOf(session: SessionId): SessionId | null;
}

/** The chain from a session up to the human gesture that started it. */
export function ancestorsOf(
  index: LineageIndex,
  session: SessionId,
): SessionId[] {
  const chain: SessionId[] = [];
  const seen = new Set<SessionId>([session]);

  let current = index.parentOf(session);
  while (current && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = index.parentOf(current);
  }

  return chain;
}

export function isInSameChain(
  index: LineageIndex,
  a: SessionId,
  b: SessionId,
): boolean {
  if (a === b) return true;
  return ancestorsOf(index, a).includes(b) || ancestorsOf(index, b).includes(a);
}

export type ReflexivityRefusal = {
  readonly reason: "own_chain";
  readonly message: string;
};

export type AuthoringCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly refusal: ReflexivityRefusal };

/**
 * Principle 1's asymmetry, as a predicate: no agent authors intent into its own
 * chain. A session may not wire its own inputs, nor those of its ancestors or
 * descendants — and cannot route around it through a chain it started.
 *
 * Humans are unconstrained; they are the authority the whole system terminates
 * at. Sessions outside each other's chains exchange context freely — that is
 * collaboration, bounded by budgets (principle 2).
 *
 * A delegation's result returning to the delegator is not this: the delegator
 * authored that intent when it delegated, so provenance edges never pass
 * through here.
 */
export function checkAuthoring(
  index: LineageIndex,
  author: Author,
  targetSession: SessionId | null,
): AuthoringCheck {
  if (author.kind === "human") return { allowed: true };
  if (!targetSession) return { allowed: true };

  if (isInSameChain(index, author.sessionId, targetSession)) {
    return {
      allowed: false,
      refusal: {
        reason: "own_chain",
        message:
          "a session cannot author context into itself, its ancestors, or its descendants",
      },
    };
  }

  return { allowed: true };
}
