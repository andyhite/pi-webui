/**
 * Approvals (Epic 6.3, §6.6).
 *
 * One record, one evaluator, one attention row. Approvals already existed in two
 * shapes before this subtree — a claim wait no policy covered (§3.4) and a
 * write-gate raise for an undeclared write extent — and they are the same event to
 * the operator, so they are one vocabulary here (`ask.ts`) rather than two feeds
 * that happen to look alike.
 *
 * - `ask.ts` — what is being asked, structured, because "answerable without opening
 *   the session" means everything needed to answer is in the row.
 * - `pre-grants.ts` — capability granted in advance, by a human, with **deny wins**
 *   precedence. `preGrantable` is where §6.6's piercing rule lives: an irreversible
 *   ask has no pre-grantable form, so no coverage verdict for one can be written.
 * - `decide.ts` — the one decision every raise path goes through (principle 8).
 * - `approval.ts` — the record, its two answers, the structural feedback a denial
 *   returns to the session, and the attention row every surface renders.
 * - `destruction.ts` — agent-requested destruction of authored state, routed by
 *   catalog metadata rather than by a second list of destructive verbs.
 */
export * from "./approval.js";
export * from "./ask.js";
export * from "./decide.js";
export * from "./destruction.js";
export * from "./ids.js";
export * from "./pre-grants.js";
