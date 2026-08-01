/**
 * Plugin health as a first-class surface (§10.2): "Plugin health is a
 * first-class surface: connected, misconfigured, failing, out of date."
 *
 * Two independent facts about a plugin, kept as two fields rather than one
 * flattened status, because they come from different places and can be
 * true or false in any combination:
 *
 * - **Lifecycle** (`loading`/`ready`/`unavailable`/`disabled`, + a reason):
 *   whether the plugin itself is running at all. Mirrors
 *   `@plotroom/plugin-sdk`'s `PluginHealth` (`host.ts`) — that type uses
 *   `"disposed"` for a torn-down host; this uses `"disabled"` for the
 *   user-facing verb (§10.2's "install, enable, disable, remove"), since a
 *   disabled plugin is a state the operator chose, not a crash. Fixture-fed
 *   until the host's lifecycle events are wired to a real transport
 *   (Epic 7.1's host lands on `main` separately from this renderer work).
 * - **Integration health**, §10.2's own words, verbatim: `connected`,
 *   `misconfigured`, `failing`, `out-of-date`. `null` until an integration
 *   substrate exists for a plugin to report through (Track A's Epic 7.2) —
 *   an honest absence, not a manufactured "connected".
 */

export const PLUGIN_LIFECYCLE_STATUSES = [
  "loading",
  "ready",
  "unavailable",
  "disabled",
] as const;

export type PluginLifecycleStatus = (typeof PLUGIN_LIFECYCLE_STATUSES)[number];

export interface PluginLifecycleState {
  readonly status: PluginLifecycleStatus;
  /** Set for `unavailable` and `disabled` — reported, never silent (§10.2). */
  readonly reason: string | null;
}

export type PluginLifecycleEvent =
  | { readonly type: "loading" }
  | { readonly type: "ready" }
  | { readonly type: "unavailable"; readonly reason: string }
  | { readonly type: "disabled"; readonly reason: string };

/** Folds one lifecycle event onto the current state — pure, so the transition rule is testable without a host. */
export function applyLifecycleEvent(
  event: PluginLifecycleEvent,
): PluginLifecycleState {
  switch (event.type) {
    case "loading":
      return { status: "loading", reason: null };
    case "ready":
      return { status: "ready", reason: null };
    case "unavailable":
      return { status: "unavailable", reason: event.reason };
    case "disabled":
      return { status: "disabled", reason: event.reason };
  }
}

/** §10.2's four integration-health states, named verbatim. */
export const INTEGRATION_HEALTH_STATES = [
  "connected",
  "misconfigured",
  "failing",
  "out-of-date",
] as const;

export type IntegrationHealthState = (typeof INTEGRATION_HEALTH_STATES)[number];

export interface IntegrationHealth {
  readonly state: IntegrationHealthState;
  readonly detail: string;
}

export interface PluginHealthEntry {
  readonly pluginId: string;
  readonly name: string;
  readonly lifecycle: PluginLifecycleState;
  /** `null`: no integration substrate reports for this plugin yet (Epic 7.2). */
  readonly integration: IntegrationHealth | null;
}
