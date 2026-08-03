/**
 * The plugin **status** vocabulary (§10.2), native side.
 *
 * `packages/plugin-sdk` owns the contract, the worker host, and the lifecycle
 * state machine; `@plotroom/core` cannot depend on it (the dependency runs the
 * other way), so what is mirrored here is only what the rest of the product has
 * to speak about a plugin: the four lifecycle states, the five health states, and
 * one row shape the `/api/plugins` read surface and the `plugin` event on the one
 * event stream both carry — so a health panel and a WS subscriber cannot describe
 * the same plugin differently (principle 8).
 *
 * Three rules this shape keeps, each of them §10.2's:
 *
 * 1. **A failure is a state with a reason, never an absence.** `unavailable`
 *    carries {@link PluginStatus.reason}; a plugin that failed is reported, never
 *    silently missing from the list (principle 12).
 * 2. **Out of date is health, not failure.** `warnings` is a list a `ready`
 *    plugin can carry — an older contract version says so and keeps working.
 * 3. **Nothing here is a grant surface.** A declared permission's state is the
 *    operator's answer, mirrored for display; no field in this module carries a
 *    credential value (§9.3), and nothing in it grants anything.
 */

/** Mirrors the host's `PluginOrigin`: where the plugin came from (§10.2). */
export const PLUGIN_STATUS_ORIGINS = ["in-box", "directory"] as const;

export type PluginStatusOrigin = (typeof PLUGIN_STATUS_ORIGINS)[number];

/**
 * Mirrors the registry's `PluginState`, plus `removed` for the event a removal
 * publishes — a subscriber told only "disabled" could not tell a plugin that was
 * turned off from one that is gone.
 */
export const PLUGIN_STATUS_STATES = [
  "installed",
  "enabled",
  "disabled",
  "removed",
] as const;

export type PluginStatusState = (typeof PLUGIN_STATUS_STATES)[number];

/**
 * Mirrors the host's `PluginHealth` statuses, plus `disabled` for the honest
 * answer about a plugin with no worker: health is a running plugin's property,
 * and reporting a disabled plugin as `ready` or as `unavailable` would both be
 * false.
 */
export const PLUGIN_HEALTH_STATES = [
  "loading",
  "ready",
  "restarting",
  "unavailable",
  "disposed",
  "disabled",
] as const;

export type PluginHealthState = (typeof PLUGIN_HEALTH_STATES)[number];

/** One declared permission and the operator's answer to it, for display (§10.2). */
export interface PluginPermissionStatus {
  readonly id: string;
  readonly kind: string;
  /** The sentence the plugin's own request carries, shown verbatim. */
  readonly reason: string;
  readonly requiredToLoad: boolean;
  /** The scope, described in one line — never the credential's value (§9.3). */
  readonly scope: string;
  readonly state: "granted" | "denied" | "never-asked";
  readonly answeredAt: number | null;
}

/** One contribution the plugin declares, named so a surface can say what it adds. */
export interface PluginContributionStatus {
  readonly point: string;
  readonly id: string;
}

/**
 * A connected use of one of this plugin's producers (§9.1–§9.3), so §10.2's
 * "connection state where applicable" is answered from the integration record
 * rather than guessed from plugin health.
 */
export interface PluginIntegrationStatus {
  readonly integrationId: string;
  readonly name: string;
  readonly producerId: string;
  readonly connectionState: string;
  readonly lastRefreshAt: number | null;
  readonly lastBrokenReason: string | null;
}

/** One row of the §10.2 health surface, whole — the shape `/api/plugins` returns. */
export interface PluginStatus {
  readonly pluginId: string;
  readonly name: string;
  readonly version: string;
  readonly contractVersion: number;
  readonly origin: PluginStatusOrigin;
  readonly state: PluginStatusState;
  readonly health: PluginHealthState;
  /** Why it is unavailable, or null. Never omitted when there is one (§10.2). */
  readonly reason: string | null;
  /** Out of date, and anything else a working plugin should still say. */
  readonly warnings: readonly string[];
  readonly permissions: readonly PluginPermissionStatus[];
  readonly contributions: readonly PluginContributionStatus[];
  readonly integrations: readonly PluginIntegrationStatus[];
  readonly installedAt: number;
}
