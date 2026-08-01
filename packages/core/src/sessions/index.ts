/**
 * Sessions and drift (Epic 1.5) plus the runtime seam (Epic 4.1).
 *
 * Everything here is runtime-independent product behavior: the session record
 * and its end states (§3.6), the transcript as content with its checkpoint rule
 * (§3.6, §6.1), drift derivation and triage (§3.2, §4.5), phase derivation, the
 * injection ledger, accounting, and fork planning. Adapters live under
 * `adapters/` and translate one runtime's surface into observations
 * (docs/decisions/0001-session-runtime-abstraction.md).
 */
export * from "./accounting.js";
export * from "./checkpoint.js";
export * from "./deletion.js";
export * from "./end-states.js";
export * from "./runtime.js";
export * from "./session.js";
export * from "./transcript.js";
