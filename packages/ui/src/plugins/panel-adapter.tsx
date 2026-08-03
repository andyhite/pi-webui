/**
 * Adapts a plugin-contributed `Panel` onto the host's own
 * `PanelDefinition` (§10.1, §11): "panels registered, including by
 * plugins" through the *exact same* `register` call the in-box panels use
 * (`panels/registry.ts`'s own doc comment) — this is that adaptation, kept
 * in its own `.tsx` file because it renders JSX and `contribution-
 * registry.ts` otherwise stays plain logic.
 */

import type { Panel } from "@plotroom/plugin-sdk";

import { definePanel, type PanelDefinition } from "../panels/registry.js";
import { PluginPanelView } from "./PluginPanelView.js";
import type { ContributionRegistry } from "./contribution-registry.js";

/**
 * Prefixed for the same reason `contribution-registry.ts`'s palette entries
 * are (`PLUGIN_PALETTE_ITEM_PREFIX`): the in-box panels register first
 * (`App.tsx`), plugin panels register after, and `PanelRegistry.register`
 * is last-write-wins by id — an unprefixed plugin panel named e.g.
 * `"plugins"` or `"fleet"` would silently replace a host panel rather than
 * being refused or renamed visibly.
 */
const PLUGIN_PANEL_ID_PREFIX = "plugin:";

export function panelDefinitionFromPanel(panel: Panel): PanelDefinition {
  return definePanel<null>({
    id: `${PLUGIN_PANEL_ID_PREFIX}${panel.id}`,
    title: panel.title,
    initialState: null,
    render: () => <PluginPanelView panel={panel} />,
  });
}

/** Every plugin panel currently registered, ready to `PanelRegistry.register` (§11). */
export function panelDefinitionsFromRegistry(
  registry: ContributionRegistry,
): readonly PanelDefinition[] {
  return registry.panels().map(panelDefinitionFromPanel);
}
