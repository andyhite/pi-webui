import type { SessionId } from "./ids.js";

/**
 * Spec §15 invariant 2: every context edge records its author.
 *
 * There is no "unknown" author. An edge cannot exist without one, which is why
 * this type has no fallback variant — retrofitting one later would make the
 * graph unable to say who decided what agents know (principle 1).
 */
export type Author =
  | { readonly kind: "human" }
  | { readonly kind: "session"; readonly sessionId: SessionId };

export const humanAuthor: Author = { kind: "human" };

export function sessionAuthor(sessionId: SessionId): Author {
  return { kind: "session", sessionId };
}

/** Provenance edges are recorded by the system, never authored (§3.7). */
export type EdgeKind = "context" | "provenance";
