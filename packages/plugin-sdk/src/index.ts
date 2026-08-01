/**
 * @plotroom/plugin-sdk — the plugin contract and host (spec §10).
 *
 * Plugins populate first-class concepts; they never add new ones (§3.1), and
 * they cannot author intent (principle 1). A plugin that throws, hangs, or
 * fails to load degrades to that plugin being unavailable, reported (§10.2).
 */

export const CONTRACT_VERSION = 0;

/**
 * The **draft** contribution contract (§10.1) and declared-permissions model
 * (§10.2), exported under a namespace that says what it is.
 *
 * Unstable and wired to nothing: `CONTRACT_VERSION` is still `0` and the host still
 * speaks only load/ping/dispose. Epic 7.1 freezes the surface in Phase 7; this is
 * drafted early so that freeze reconciles reviewed shapes against the native
 * implementations rather than inventing them (see `docs/plugin-contract-draft.md`).
 * Do not build a plugin against it — `draft.*` will change without ceremony.
 */
export * as draft from "./draft/index.js";

export {
  PluginHost,
  PluginUnavailableError,
  type PluginHealth,
  type PluginHostOptions,
} from "./host.js";
export type {
  HostToWorkerMessage,
  PluginModule,
  WorkerBootData,
  WorkerToHostMessage,
} from "./protocol.js";
