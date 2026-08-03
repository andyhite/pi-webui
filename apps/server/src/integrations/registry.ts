import type {
  ConceptProducer,
  Renderings as PluginRenderings,
  WriteAction,
} from "@plotroom/plugin-sdk";
import type { Renderings } from "@plotroom/core";

/**
 * The integration producer registry (§9.1–§9.3, Epic 7.2) — **now backed by the
 * real worker host** (§10.2, Epic 7.1's freeze).
 *
 * This used to be a same-process direct-invocation seam standing in for Track C's
 * plugin host, and its own docstring said it would be **replaced rather than
 * extended** when that host landed. It has been:
 * `apps/server/src/plugins/producers.ts` builds an {@link IntegrationProducer} whose
 * `read` and `perform` are `PluginHost.invoke` — one worker thread per plugin,
 * permissions gated at the boundary, credentials injected per call and redacted out
 * of the answer — and `PluginService` registers those when a plugin is enabled and
 * unregisters them when it is disabled.
 *
 * **Nothing above this registry changed**, which was the seam's whole claim: the
 * store, the service, the routes and the catalog tools only ever call
 * `producer.read(...)` and `action.perform(...)`, both `Promise`-returning per the
 * frozen contract, and none of them assumed same-process execution.
 *
 * A registration is therefore live rather than permanent — {@link
 * IntegrationRegistry.unregister} exists because "disable, per plugin, without
 * restarting" (§10.2) has to mean the producer stops being reachable, not merely
 * that its worker stopped. An integration connected to a disabled plugin's producer
 * keeps its row and its objects (§3.1: present-or-absent, never degraded); what it
 * loses is the ability to refresh, and `IntegrationService` reports that as the
 * unknown producer it now is.
 *
 * One extension of the contract's own shape survives here, additive rather than a
 * change to its field list:
 * `ConceptProducer`/`WriteAction` name no plugin, and a registry needs to
 * group a producer's actions and know which plugin owns which credential
 * namespace, so {@link IntegrationProducer} adds `pluginId`.
 *
 * One bridge from the draft still applies: `Renderings.card` is `string` in
 * the contract but `Readonly<Record<string, unknown>>` in `@plotroom/core`'s
 * `Renderings` (`packages/core/src/renderings.ts`) — {@link toCoreRenderings}
 * parses the string as JSON, falling back to `{ text: <string> }` for a
 * producer that returns plain text. The other bridge did not survive it:
 * `@plotroom/core`'s `ObjectKind` and the contract's `ConceptKind` mirror each
 * other exactly now (`docs/plugin-contract.md` §7.13 — the draft's own
 * `"pull-request"` misspelling is corrected to `"pull_request"`), so a
 * producer's declared kind (`ConceptKind`) is a core `ObjectKind` with no
 * translation; the former `toCoreObjectKind` bridge is deleted rather than
 * kept as an identity function, per that section's own instruction.
 */
export interface IntegrationProducer extends ConceptProducer {
  readonly pluginId: string;
  readonly writeActions?: readonly WriteAction[];
}

export function toCoreRenderings(rendered: PluginRenderings): Renderings {
  return {
    card: parseCard(rendered.card),
    summary: rendered.summary,
    agentContent: rendered.agentContent,
  };
}

function parseCard(card: string): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(card);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Not JSON — fall through to the text wrapper below.
  }
  return { text: card };
}

export class IntegrationRegistry {
  private readonly producers = new Map<string, IntegrationProducer>();

  register(producer: IntegrationProducer): void {
    this.producers.set(producer.id, producer);
  }

  /** Take a producer away again: what a plugin being disabled means (§10.2). */
  unregister(producerId: string): void {
    this.producers.delete(producerId);
  }

  get(producerId: string): IntegrationProducer | undefined {
    return this.producers.get(producerId);
  }

  list(): readonly IntegrationProducer[] {
    return [...this.producers.values()];
  }

  writeAction(producerId: string, actionId: string): WriteAction | undefined {
    return this.get(producerId)?.writeActions?.find(
      (action) => action.id === actionId,
    );
  }
}
