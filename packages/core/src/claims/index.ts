/**
 * Path claims (Epic 4.4, §3.4) — "one writer per path, always" (principle 4).
 *
 * The subtree is split the way the spec's own sentences are:
 *
 * - `paths.ts` — canonicalization and the hierarchical conflict rule. Nothing
 *   here touches a filesystem, which is why claims on not-yet-existing paths are
 *   ordinary rather than special.
 * - `policy.ts` — pre-granted allow/deny policies, so interactive approval is the
 *   exception rather than the mechanism.
 * - `model.ts` — the records, the effects Track A persists, and the invariants as
 *   predicates: no claim exceeds its granter's extent, one writer per path.
 * - `deadlock.ts` — the wait-for graph, and the actionable refusal of the newest
 *   claim in a cycle.
 * - `manager.ts` — the decision functions themselves: request, yield, inspect,
 *   grant, force-release, expire, and end-of-session release, pure and with an
 *   injected clock.
 * - `divergence.ts` — claim-precise staleness, which narrows Epic 4.3's
 *   conservative continuation gate in both directions.
 */
export * from "./deadlock.js";
export * from "./divergence.js";
export * from "./ids.js";
export * from "./manager.js";
export * from "./model.js";
export * from "./paths.js";
export * from "./policy.js";
