/**
 * Adapts a plugin-contributed `DraftPanel` onto the host's own
 * `PanelDefinition` (§10.1, §11): "panels registered, including by
 * plugins" through the *exact same* `register` call the in-box panels use
 * (`panels/registry.ts`'s own doc comment) — this is that adaptation, kept
 * in its own `.tsx` file because it renders JSX and `contribution-
 * registry.ts` otherwise stays plain logic.
 */

import type { draft } from "@plotroom/plugin-sdk";

import { definePanel, type PanelDefinition } from "../panels/registry.js";
import { PluginPanelView } from "./PluginPanelView.js";
import type { ContributionRegistry } from "./contribution-registry.js";

export function panelDefinitionFromDraft(
  panel: draft.DraftPanel,
): PanelDefinition {
  return definePanel<null>({
    id: panel.id,
    title: panel.title,
    initialState: null,
    render: () => <PluginPanelView panel={panel} />,
  });
}

/** Every plugin panel currently registered, ready to `PanelRegistry.register` (§11). */
export function panelDefinitionsFromRegistry(
  registry: ContributionRegistry,
): readonly PanelDefinition[] {
  return registry.panels().map(panelDefinitionFromDraft);
}
