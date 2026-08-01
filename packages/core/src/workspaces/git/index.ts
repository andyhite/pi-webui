/**
 * The git workspace kind (§3.4, Epic 4.3) — mechanism for the contract in
 * `../kind.ts`. `host-auth.ts` is the only module here that names credential
 * material, and it names it to refuse it.
 */
export * from "./branch-template.js";
export * from "./config.js";
export * from "./discovery.js";
export * from "./exec.js";
export * from "./host-auth.js";
export * from "./kind.js";
export * from "./provision.js";
export * from "./status.js";
