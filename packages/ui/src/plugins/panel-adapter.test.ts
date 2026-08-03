import { describe, expect, it } from "vitest";
import type { Panel } from "@plotroom/plugin-sdk";

import { createContributionRegistry } from "./contribution-registry.js";
import {
  panelDefinitionFromPanel,
  panelDefinitionsFromRegistry,
} from "./panel-adapter.js";

function panel(overrides: Partial<Panel> = {}): Panel {
  return {
    id: "plugins",
    title: "a plugin panel",
    placement: "right",
    render: async () => ({ title: "x", lines: [], actions: [] }),
    ...overrides,
  };
}

describe("panelDefinitionFromPanel", () => {
  it("prefixes the panel id so it can never collide with an in-box panel's own id", () => {
    const definition = panelDefinitionFromPanel(panel({ id: "plugins" }));
    expect(definition.id).toBe("plugin:plugins");
    expect(definition.id).not.toBe("plugins");
  });

  it("keeps the title unprefixed \u2014 only the registry key changes", () => {
    const definition = panelDefinitionFromPanel(panel({ title: "Filesystem" }));
    expect(definition.title).toBe("Filesystem");
  });
});

describe("panelDefinitionsFromRegistry", () => {
  it("adapts every registered plugin panel with the same prefix, never colliding with a host panel named the same", () => {
    const registry = createContributionRegistry();
    registry.registerManifest("filesystem", {
      id: "filesystem",
      name: "filesystem",
      version: "0.0.0",
      contractVersion: 1,
      permissions: [],
      contributions: { panels: [panel({ id: "fleet" })] },
    });

    const definitions = panelDefinitionsFromRegistry(registry);

    expect(definitions).toHaveLength(1);
    expect(definitions[0]?.id).toBe("plugin:fleet");
    expect(definitions[0]?.id).not.toBe("fleet");
  });
});
