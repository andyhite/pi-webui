/**
 * Attention and triage (§7, Epic 6.1) — the derivation half.
 *
 * "One derivation, many surfaces. What each session needs is computed once and
 * rendered everywhere." This subtree is that one computation: `derive.ts` turns
 * six feeds of records PlotRoom already keeps into one ranked list, `health.ts`
 * derives §7.2's five alerts **from observation only**, `routing.ts` states
 * §7.3's outbound rules (a route attaches to a state, edge-triggered, redacted),
 * and `ids.ts` keeps every row's id a function of the fact behind it so a resync
 * cannot make an open item look new.
 *
 * Nothing here initiates anything. A health alert is a reading, not an
 * intervention; a queue row is a request for a decision, never a decision
 * (principle 2).
 */
export * from "./derive.js";
export * from "./health.js";
export * from "./ids.js";
export * from "./routing.js";
export * from "./types.js";
