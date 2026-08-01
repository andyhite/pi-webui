/**
 * The renderer contribution registry (§10.1, Epic 7.1's renderer half).
 *
 * Consumes manifest-shaped declarations from `@plotroom/plugin-sdk`'s
 * `draft.*` contract — unstable, wired to nothing on the host side yet, but
 * the shape the freeze reconciles against (`docs/plugin-contract-draft.md`).
 * This registry is the client-side seam every in-box plugin (Filesystem,
 * GitHub, Jira, Coding/git) registers a manifest through, the exact same
 * path a third-party plugin's manifest would use once dynamic loading
 * exists — see `in-box-modules.ts` for that seam's static v1 shape.
 *
 * Two things this file is deliberately not:
 *
 * - **Not a loader.** v1 is "in-box plugins compile into the app" — a
 *   static list of manifests, never a fetch of remote code. Dynamic remote
 *   loading is deferred (recorded in `in-box-modules.ts`); the contract
 *   supports it, this registry doesn't load it yet.
 * - **Not the only way a concept renders.** Every resolver here returns
 *   `null`/`undefined` rather than a manufactured value when nothing is
 *   registered, so a caller's own default rendering is always the
 *   fallback — concepts never render broken because a plugin declined to
 *   contribute, and a throwing plugin degrades to that same fallback
 *   rather than crashing the caller (§10.2: a throwing contribution is an
 *   unavailable contribution, never a broken host).
 */

import type { draft } from "@plotroom/plugin-sdk";

import type { CanvasCardAction, CanvasCardView } from "../canvas/PlotCanvas.js";
import type { CommandPaletteItem } from "../command-palette/model.js";

export interface RegisteredManifest {
  readonly pluginId: string;
  readonly manifest: draft.DraftPluginManifest;
}

export interface ContributionRegistry {
  registerManifest(pluginId: string, manifest: draft.DraftPluginManifest): void;
  unregisterManifest(pluginId: string): void;
  listManifests(): readonly RegisteredManifest[];
  /** First-registered-wins: the in-box four each own a disjoint kind set today. */
  cardRendererFor(
    kind: draft.DraftConceptKind,
  ): draft.DraftCardRenderer | undefined;
  contentRendererFor(
    kind: draft.DraftConceptKind,
  ): draft.DraftContentRenderer | undefined;
  paletteEntries(): readonly draft.DraftPaletteEntry[];
  panels(): readonly draft.DraftPanel[];
}

export function createContributionRegistry(): ContributionRegistry {
  const manifests = new Map<string, draft.DraftPluginManifest>();

  function firstMatch<T>(
    pick: (manifest: draft.DraftPluginManifest) => readonly T[] | undefined,
    matches: (item: T) => boolean,
  ): T | undefined {
    for (const manifest of manifests.values()) {
      const found = (pick(manifest) ?? []).find(matches);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  return {
    registerManifest(pluginId, manifest) {
      manifests.set(pluginId, manifest);
    },
    unregisterManifest(pluginId) {
      manifests.delete(pluginId);
    },
    listManifests() {
      return [...manifests.entries()].map(([pluginId, manifest]) => ({
        pluginId,
        manifest,
      }));
    },
    cardRendererFor(kind) {
      return firstMatch(
        (manifest) => manifest.cardRenderers,
        (renderer) => renderer.kinds.includes(kind),
      );
    },
    contentRendererFor(kind) {
      return firstMatch(
        (manifest) => manifest.contentRenderers,
        (renderer) => renderer.kinds.includes(kind),
      );
    },
    paletteEntries() {
      return [...manifests.values()].flatMap(
        (manifest) => manifest.paletteEntries ?? [],
      );
    },
    panels() {
      return [...manifests.values()].flatMap(
        (manifest) => manifest.panels ?? [],
      );
    },
  };
}

/** `DraftCardView` -> the canvas's own (decoupled) card view shape. */
function toCanvasCardView(view: draft.DraftCardView): CanvasCardView {
  const actions: CanvasCardAction[] = view.actions.map((action) => ({
    id: action.id,
    label: action.label,
    writeActionId: action.writeActionId,
  }));
  return { title: view.title, lines: view.lines, actions };
}

/**
 * Resolves a card for one concept, compact or expanded (§10.1, §3.2).
 * `null` means "no plugin renderer claims this kind, or the one that does
 * threw" — either way the caller's own default rendering applies. A
 * throwing renderer never propagates: it degrades to the same `null` a
 * missing renderer would produce (§10.2).
 */
export async function resolveCardView(
  registry: ContributionRegistry,
  object: draft.DraftProducedObject,
  detail: "compact" | "expanded",
): Promise<CanvasCardView | null> {
  const renderer = registry.cardRendererFor(object.kind);
  if (!renderer) return null;
  try {
    return toCanvasCardView(await renderer.renderCard(object, detail));
  } catch {
    return null;
  }
}

/**
 * The delta hook (§10.1, §3.2): "what's new" is kind-specific, so it is a
 * contribution point rather than something the host computes. `null` means
 * no plugin content renderer claims this kind, or it threw — the same
 * degrade-to-absent rule `resolveCardView` follows.
 */
export async function resolveContentDelta(
  registry: ContributionRegistry,
  previous: draft.DraftProducedObject,
  next: draft.DraftProducedObject,
): Promise<draft.DraftRenderedContent | null> {
  const renderer = registry.contentRendererFor(next.kind);
  if (!renderer) return null;
  try {
    return await renderer.renderDelta(previous, next);
  } catch {
    return null;
  }
}

/**
 * Plugin palette/command-palette entries (§10.1, §11), surfaced through the
 * command palette: `DraftPaletteEntry.invoke()` is a verb with no drag
 * payload, so it maps onto `CommandPaletteItem`'s `"verb"` kind rather than
 * `PaletteRail`'s drag sources, which are typed to core `ObjectKind`s a
 * plugin never adds to (§3.1). Prefixed so a plugin's own id never collides
 * with an in-box verb's.
 */
const PLUGIN_PALETTE_ITEM_PREFIX = "plugin:";

export function commandPaletteItemsFromRegistry(
  registry: ContributionRegistry,
): readonly CommandPaletteItem[] {
  return registry.paletteEntries().map((entry) => ({
    id: `${PLUGIN_PALETTE_ITEM_PREFIX}${entry.id}`,
    label: entry.label,
    kind: "verb" as const,
  }));
}

/** `false`: `itemId` was not a plugin entry, so the caller's own verbs apply. */
export async function invokePluginPaletteEntry(
  registry: ContributionRegistry,
  itemId: string,
): Promise<boolean> {
  if (!itemId.startsWith(PLUGIN_PALETTE_ITEM_PREFIX)) return false;
  const entryId = itemId.slice(PLUGIN_PALETTE_ITEM_PREFIX.length);
  const entry = registry
    .paletteEntries()
    .find((candidate) => candidate.id === entryId);
  if (!entry) return false;
  await entry.invoke();
  return true;
}
