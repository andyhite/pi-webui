/**
 * Workspaces (Epic 4.3, §3.4).
 *
 * "A workspace is where work physically happens. One workstream owns exactly
 * one workspace; workspaces never cross workstreams. The *boundary* is
 * guaranteed by the product; the *mechanism* is supplied per workspace kind."
 *
 * This subtree is split along that sentence. `workspace.ts`, `readiness.ts`,
 * `divergence.ts`, and `lifecycle.ts` are the product's half — record shape,
 * boundary, readiness gate, divergence and the continuation gate it feeds,
 * removal protections — and none of them ask a kind anything. `kind.ts` is the
 * mechanism contract; `git/` is the first implementation of it.
 */
export * from "./divergence.js";
/** `EpochMillis` is re-exported by `sessions/runtime.ts`, which owns it. */
export type {
  MillisClock,
  ShellCommand,
  CommandResult,
  CommandExec,
  DiskUsageProbe,
} from "./exec.js";
export { systemMillisClock } from "./exec.js";
export * from "./ids.js";
export * from "./kind.js";
export * from "./lifecycle.js";
export * from "./readiness.js";
export * from "./workspace.js";
