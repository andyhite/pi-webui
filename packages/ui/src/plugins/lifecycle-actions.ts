/**
 * Per-plugin enable/disable/remove (§10.2: "install, enable, disable,
 * remove — per plugin, without restarting"). The verbs call lifecycle
 * endpoints that do not exist yet (Epic 7.1's host has load/ping/dispose
 * only — see `docs/plugin-contract-draft.md`'s "the lifecycle verbs are
 * absent"), so `createUnavailableLifecycleActions` is the honest stand-in:
 * every call refuses with a stated reason rather than silently succeeding
 * or silently doing nothing. Once the endpoints exist, a real
 * `PluginLifecycleActions` implementation over them is a drop-in
 * replacement — nothing that consumes this interface changes.
 */

import type { ActionResult, ApiRefusal } from "../data-source/actions.js";

export interface PluginLifecycleActions {
  enable(pluginId: string): Promise<ActionResult<void>>;
  disable(pluginId: string): Promise<ActionResult<void>>;
  remove(pluginId: string): Promise<ActionResult<void>>;
}

const NOT_IMPLEMENTED_REFUSAL: ApiRefusal = {
  reason: "not-implemented",
  message:
    "plugin lifecycle endpoints do not exist yet (Epic 7.1: enable/disable/remove are host-side and undrafted) — this verb is honestly refused, not silently accepted",
};

/** Every verb refuses with the same stated reason — honest, not a silent no-op. */
export function createUnavailableLifecycleActions(): PluginLifecycleActions {
  const refuse = (): Promise<ActionResult<void>> =>
    Promise.resolve({ ok: false, refusal: NOT_IMPLEMENTED_REFUSAL });
  return {
    enable: refuse,
    disable: refuse,
    remove: refuse,
  };
}
