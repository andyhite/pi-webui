import {
  declareToolWorld,
  integrationToolName,
  type ToolWorldDeclarations,
  type WriteReversibility,
} from "@plotroom/core";
import type { IntegrationRegistry } from "./registry.js";

/**
 * The registry's own `ToolWorldDeclarations` (§9.2, §6.3), for
 * `createSessionGate` — the Batch-4 external-write seam
 * (`decideToolPermission`, `toolCallAsk`, `decideApproval`) that gate.ts's
 * docstring already names as what a declared write action plugs into.
 *
 * Built fresh from every registered producer's write actions, keyed by
 * {@link integrationToolName} so a running session's call to
 * `integration:<producerId>:<actionId>` resolves to exactly the reversibility
 * the plugin declared — never a call site's guess.
 *
 * Nothing calls this today with a real running session: the pi and scripted
 * adapters' own tool surfaces do not yet expose a plugin's write actions as
 * runtime tools (that wiring is Track C's host, once it lands). Wired into
 * `createSessionGate` anyway, because the alternative — leaving `world` unset —
 * is what `app.ts` already had to say out loud for fork cleanliness: "empty
 * until Phase 7's integrations declare any." They declare some now, so the gate
 * has something to answer with the moment a runtime starts asking.
 */
export function integrationWorldDeclarations(
  registry: IntegrationRegistry,
): ToolWorldDeclarations {
  const entries: Record<
    string,
    {
      readonly kind: "outside-world";
      readonly system: string;
      readonly action: string;
      readonly reversibility: WriteReversibility;
    }
  > = {};

  for (const producer of registry.list()) {
    for (const action of producer.writeActions ?? []) {
      entries[integrationToolName(producer.id, action.id)] = {
        kind: "outside-world",
        system: action.system,
        action: action.action,
        reversibility: action.reversibility,
      };
    }
  }

  return declareToolWorld(entries);
}
