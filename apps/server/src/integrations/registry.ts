import type { draft } from "@plotroom/plugin-sdk";
import type { ObjectKind, Renderings } from "@plotroom/core";

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
 * `action.perform(...)`, both already `Promise`-returning per the draft
 * contract.
 *
 * Built against `@plotroom/plugin-sdk`'s `draft.*` shapes, per the batch
 * assignment: "build the server-side substrate against the DRAFT types'
 * shapes (semantics won't move much; C will list deviations; you'll reconcile
 * at rebase)." Two shapes needed extending beyond the draft as written, both
 * recorded here rather than silently patched into the draft file (which is
 * Track C's subtree):
 *
 * - `DraftConceptProducer`/`DraftWriteAction` name no plugin. A registry needs
 *   to group a producer's actions and know which plugin owns which credential
 *   namespace, so {@link IntegrationProducer} adds `pluginId` — additive, not a
 *   change to the draft's own field list.
 * - `DraftRenderings.card` is `string`; `@plotroom/core`'s `Renderings.card` is
 *   `Readonly<Record<string, unknown>>` (`packages/core/src/renderings.ts`).
 *   {@link toCoreRenderings} bridges the two by parsing the string as JSON
 *   (falling back to `{ text: <string> }` for a producer that returns plain
 *   text) — see `docs/plugin-contract-draft.md`'s reconciliation note for
 *   which side this is expected to resolve on at the freeze.
 * - `DraftConceptKind` spells one member `"pull-request"`; `@plotroom/core`'s
 *   `ObjectKind` (`packages/core/src/objects.ts`) spells the same concept
 *   `"pull_request"`. A hyphen-vs-underscore drift a TypeScript build catches
 *   immediately, which is exactly why it is caught here rather than at the
 *   freeze: {@link toCoreObjectKind} is the one place that translates, so a
 *   producer keeps writing the draft's own spelling.
 */
export interface IntegrationProducer extends draft.DraftConceptProducer {
  readonly pluginId: string;
  readonly writeActions?: readonly draft.DraftWriteAction[];
}

export function toCoreRenderings(rendered: draft.DraftRenderings): Renderings {
  return {
    card: parseCard(rendered.card),
    summary: rendered.summary,
    agentContent: rendered.agentContent,
  };
}

/** See the class docstring's third deviation: `"pull-request"` vs `"pull_request"`. */
export function toCoreObjectKind(kind: draft.DraftConceptKind): ObjectKind {
  return kind === "pull-request" ? "pull_request" : kind;
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

  writeAction(
    producerId: string,
    actionId: string,
  ): draft.DraftWriteAction | undefined {
    return this.get(producerId)?.writeActions?.find(
      (action) => action.id === actionId,
    );
  }
}
