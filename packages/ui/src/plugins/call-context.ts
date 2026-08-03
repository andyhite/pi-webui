/**
 * A neutral `PluginCallContext` for a renderer-side call made directly
 * against an in-box manifest's handler — not over the worker host's RPC
 * (`in-box-modules.ts`'s own doc comment: in-box plugins compile in as
 * plain declarations, so there is no host to inject a real context yet).
 *
 * `actor` is `null` for every use here: card renderers, content renderers,
 * panels, and palette entries are never agent-tool calls, and the contract
 * states the actor is non-null only for one (`PluginCallContext.actor`'s
 * own doc comment). `credentials` and `grants` are empty for the same
 * reason there is no host yet to resolve either.
 */

import type { PluginCallContext } from "@plotroom/plugin-sdk";

export function createRendererCallContext(): PluginCallContext {
  return {
    invocationId: crypto.randomUUID(),
    actor: null,
    credentials: {},
    grants: [],
    log: () => {},
  };
}
