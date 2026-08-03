import type {
  ConceptProducer,
  Renderings as PluginRenderings,
  WriteAction,
} from "@plotroom/plugin-sdk";
import type { Renderings } from "@plotroom/core";

/**
 * The integration producer registry — Epic 7.2's direct-invocation seam
 * standing in for Track C's plugin host.
 *
 * **This is a stand-in, and it says so on every export.** Track C's host
 * (`packages/plugin-sdk`) still speaks only load/ping/dispose; nothing loads a
 * real out-of-process plugin yet. Until it does, a producer is a same-process
 * object registered here directly rather than discovered from a worker. When
 * C's host lands, this registry's `register`/`get`/`list` surface is what a
 * loader calls into — the substrate above it (the store, the service, the
 * routes, the catalog tools) does not change, because none of it assumes
 * same-process execution; it only ever calls `producer.read(...)` and
 * `action.perform(...)`, both already `Promise`-returning per the frozen
 * contract.
 *
 * Rebased onto the frozen contract (`packages/plugin-sdk/src/contract/`,
 * `docs/plugin-contract.md`); `draft.*` is gone. One extension survives the
 * freeze, additive rather than a change to the contract's own field list:
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
