import { describe, expect, it } from "vitest";

import {
  IN_BOX_PLUGIN_MODULES,
  createInBoxContributionRegistry,
} from "./in-box-modules.js";
import { resolveCardView } from "./contribution-registry.js";

describe("IN_BOX_PLUGIN_MODULES", () => {
  it("carries the Filesystem plugin (Track B's Stage 2, §9.4)", () => {
    const filesystem = IN_BOX_PLUGIN_MODULES.find(
      (module) => module.pluginId === "filesystem",
    );
    expect(filesystem).toBeDefined();
    expect(filesystem?.manifest.id).toBe("filesystem");
    expect(filesystem?.manifest.contractVersion).toBe(1);
  });

  it("registers pluginId consistent with each manifest's own id", () => {
    for (const module of IN_BOX_PLUGIN_MODULES) {
      expect(module.pluginId).toBe(module.manifest.id);
    }
  });
});

describe("createInBoxContributionRegistry", () => {
  it("seeds a registry that resolves Filesystem's card and palette entry — the browse/drag surface", async () => {
    const registry = createInBoxContributionRegistry();

    expect(registry.cardRendererFor("document")).toBeDefined();

    const paletteIds = registry.paletteEntries().map((entry) => entry.id);
    expect(paletteIds).toContain("browse");

    const view = await resolveCardView(
      registry,
      {
        kind: "document",
        externalId: "/tmp/example.txt",
        title: "example.txt",
        renderings: {
          card: JSON.stringify({
            fsKind: "file",
            sizeBytes: 3,
            truncated: null,
          }),
          summary: "file · 3 bytes",
          agentContent: "hi\n",
        },
      },
      "compact",
    );
    expect(view?.title).toContain("file");
    expect(view?.actions).toEqual([]);
  });
});
