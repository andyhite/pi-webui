/**
 * @plotroom/plugin-sdk — the plugin contract and host (spec §10).
 *
 * Plugins populate first-class concepts; they never add new ones (§3.1), and
 * they cannot author intent (principle 1). A plugin that throws, hangs, or
 * fails to load degrades to that plugin being unavailable, reported (§10.2).
 */

export const CONTRACT_VERSION = 0;

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
