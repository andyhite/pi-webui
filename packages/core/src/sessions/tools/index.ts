/**
 * The agent tool surface (Epic 4.5).
 *
 * "Every gesture a human has is available to an agent as a tool, over the same
 * vocabulary... The asymmetry is _reflexivity_" (principle 8).
 *
 * - `catalog.ts` — the one declaration of the vocabulary, pinned to the server's
 *   mounted routes by its test in both directions.
 * - `reflexivity.ts` — principle 1 as a refusal at the point of call, over the
 *   Epic 1.2 lineage model, plus the propose-and-accept shape for targets that
 *   include the caller.
 * - `bridge.ts` — the runtime-facing bridge that *sets* the actor from the session
 *   it serves, and refuses an agent-supplied one. The Epic 2.2 carry-over.
 * - `gate.ts` — per-call permission decisions where claims gate the runtime, with
 *   an unknown write extent treated as unbounded rather than as harmless.
 * - `delegation.ts` — child dispatch with provenance, and the spend-attribution
 *   rows budgets will enforce against in Phase 6.
 */
export * from "./bridge.js";
export * from "./catalog.js";
export * from "./delegation.js";
export * from "./gate.js";
export * from "./reflexivity.js";
