/**
 * `@plotroom/plugin-sdk` — the plugin contract and host (§10).
 *
 * **Contract v1 is frozen.** A plugin's default export is a `PluginManifest`
 * declaring what it is, what it needs, and what it contributes across the twelve
 * §10.1 contribution points; the host runs it in its own worker thread, gates every
 * call against the operator's grants, and degrades a plugin that throws, hangs,
 * fails to load, or does not conform to *that plugin being unavailable, reported*
 * (§10.2) — never a product that will not start.
 *
 * Plugins populate first-class concepts; they never add new ones (§3.1), and they
 * **cannot author intent** (principle 1): a plugin's tool acts as the calling
 * session, supplied by the host, and there is no capability, message, or field by
 * which a plugin draws a context edge.
 *
 * See `docs/plugin-contract.md` for the prose — including what v1 enforces and what
 * it only documents.
 */

export * from "./contract/index.js";

export {
  PluginHost,
  PluginUnavailableError,
  PluginCallRefusedError,
  DEFAULT_RESTART_POLICY,
  type PluginHealth,
  type PluginHostOptions,
  type RestartPolicy,
} from "./host.js";

export {
  PluginRegistry,
  PluginNotInstalledError,
  discoverPluginEntries,
  PLUGIN_ENTRY_FILES,
  PLUGIN_ORIGINS,
  PLUGIN_STATES,
  type InstallResult,
  type PluginInstallFailure,
  type PluginOrigin,
  type PluginRecord,
  type PluginRegistryEvent,
  type PluginRegistryOptions,
  type PluginState,
} from "./registry.js";

export {
  redactCredentials,
  MINIMUM_REDACTABLE_LENGTH,
  type CredentialResolver,
  type InjectedCredential,
} from "./credentials.js";

export type {
  HostToWorkerMessage,
  InvocationKind,
  InvocationOf,
  InvocationResults,
  PluginInvocation,
  ResultOf,
  WireCallContext,
  WorkerBootData,
  WorkerToHostMessage,
} from "./protocol.js";
