import { describe, expect, it, vi } from "vitest";
import type { draft } from "@plotroom/plugin-sdk";

import {
  commandPaletteItemsFromRegistry,
  createContributionRegistry,
  invokePluginPaletteEntry,
  resolveCardView,
  resolveContentDelta,
} from "./contribution-registry.js";

function producedObject(
  overrides: Partial<draft.DraftProducedObject> = {},
): draft.DraftProducedObject {
  return {
    kind: "document",
    externalId: "ext_1",
    title: "a document",
    renderings: { card: "a document", summary: "a document", agentContent: "" },
    ...overrides,
  };
}

function cardRenderer(
  kinds: readonly draft.DraftConceptKind[],
  renderCard: draft.DraftCardRenderer["renderCard"],
): draft.DraftCardRenderer {
  return { kinds, renderCard };
}

describe("createContributionRegistry", () => {
  it("registers and lists manifests, including by plugins later — a registry, not a hardcoded list", () => {
    const registry = createContributionRegistry();
    registry.registerManifest("filesystem", {
      name: "filesystem",
      version: "0.0.0",
      contractVersion: 0,
      permissions: [],
    });
    expect(registry.listManifests()).toEqual([
      {
        pluginId: "filesystem",
        manifest: expect.objectContaining({ name: "filesystem" }),
      },
    ]);
  });

  it("unregisterManifest removes a manifest and everything it contributed", () => {
    const registry = createContributionRegistry();
    registry.registerManifest("filesystem", {
      name: "filesystem",
      version: "0.0.0",
      contractVersion: 0,
      permissions: [],
      cardRenderers: [
        cardRenderer(["document"], async () => ({
          title: "x",
          lines: [],
          actions: [],
        })),
      ],
    });
    registry.unregisterManifest("filesystem");
    expect(registry.listManifests()).toEqual([]);
    expect(registry.cardRendererFor("document")).toBeUndefined();
  });

  it("cardRendererFor finds the renderer that claims a kind, undefined otherwise", () => {
    const registry = createContributionRegistry();
    const renderer = cardRenderer(["document"], async () => ({
      title: "x",
      lines: [],
      actions: [],
    }));
    registry.registerManifest("filesystem", {
      name: "filesystem",
      version: "0.0.0",
      contractVersion: 0,
      permissions: [],
      cardRenderers: [renderer],
    });
    expect(registry.cardRendererFor("document")).toBe(renderer);
    expect(registry.cardRendererFor("ticket")).toBeUndefined();
  });

  it("first-registered-wins when two manifests claim the same kind", () => {
    const registry = createContributionRegistry();
    const first = cardRenderer(["document"], async () => ({
      title: "first",
      lines: [],
      actions: [],
    }));
    const second = cardRenderer(["document"], async () => ({
      title: "second",
      lines: [],
      actions: [],
    }));
    registry.registerManifest("a", {
      name: "a",
      version: "0.0.0",
      contractVersion: 0,
      permissions: [],
      cardRenderers: [first],
    });
    registry.registerManifest("b", {
      name: "b",
      version: "0.0.0",
      contractVersion: 0,
      permissions: [],
      cardRenderers: [second],
    });
    expect(registry.cardRendererFor("document")).toBe(first);
  });
});

describe("resolveCardView", () => {
  it("returns null when no plugin claims the kind — the caller's own default rendering applies", async () => {
    const registry = createContributionRegistry();
    const view = await resolveCardView(registry, producedObject(), "compact");
    expect(view).toBeNull();
  });

  it("resolves the registered renderer's card, compact and expanded", async () => {
    const registry = createContributionRegistry();
    const renderCard = vi.fn(
      async (_object, detail: "compact" | "expanded") => ({
        title: `title (${detail})`,
        lines: ["a line"],
        actions: [{ id: "open", label: "Open", writeActionId: null }],
      }),
    );
    registry.registerManifest("filesystem", {
      name: "filesystem",
      version: "0.0.0",
      contractVersion: 0,
      permissions: [],
      cardRenderers: [cardRenderer(["document"], renderCard)],
    });

    const compact = await resolveCardView(
      registry,
      producedObject(),
      "compact",
    );
    expect(compact).toEqual({
      title: "title (compact)",
      lines: ["a line"],
      actions: [{ id: "open", label: "Open", writeActionId: null }],
    });
    expect(renderCard).toHaveBeenCalledWith(expect.anything(), "compact");

    const expanded = await resolveCardView(
      registry,
      producedObject(),
      "expanded",
    );
    expect(expanded?.title).toBe("title (expanded)");
  });

  it("degrades to null (never throws) when the registered renderer throws — the concept never renders broken", async () => {
    const registry = createContributionRegistry();
    registry.registerManifest("broken", {
      name: "broken",
      version: "0.0.0",
      contractVersion: 0,
      permissions: [],
      cardRenderers: [
        cardRenderer(["document"], async () => {
          throw new Error("exploded");
        }),
      ],
    });

    await expect(
      resolveCardView(registry, producedObject(), "compact"),
    ).resolves.toBeNull();
  });

  it("degrades to null when the registered renderer rejects", async () => {
    const registry = createContributionRegistry();
    registry.registerManifest("broken", {
      name: "broken",
      version: "0.0.0",
      contractVersion: 0,
      permissions: [],
      cardRenderers: [
        cardRenderer(["document"], () => Promise.reject(new Error("nope"))),
      ],
    });

    await expect(
      resolveCardView(registry, producedObject(), "compact"),
    ).resolves.toBeNull();
  });
});

describe("resolveContentDelta", () => {
  it("returns null when no plugin content renderer claims the kind", async () => {
    const registry = createContributionRegistry();
    const result = await resolveContentDelta(
      registry,
      producedObject({ title: "old" }),
      producedObject({ title: "new" }),
    );
    expect(result).toBeNull();
  });

  it("resolves the registered content renderer's delta", async () => {
    const registry = createContributionRegistry();
    const renderDelta = vi.fn(
      async (
        previous: draft.DraftProducedObject,
        next: draft.DraftProducedObject,
      ) => ({
        content: `${previous.title} -> ${next.title}`,
        truncated: null,
      }),
    );
    registry.registerManifest("filesystem", {
      name: "filesystem",
      version: "0.0.0",
      contractVersion: 0,
      permissions: [],
      contentRenderers: [
        {
          kinds: ["document"],
          renderAgentContent: async (object) => ({
            content: object.title,
            truncated: null,
          }),
          renderDelta,
        },
      ],
    });

    const result = await resolveContentDelta(
      registry,
      producedObject({ title: "old" }),
      producedObject({ title: "new" }),
    );
    expect(result).toEqual({ content: "old -> new", truncated: null });
  });

  it("degrades to null when the registered content renderer throws", async () => {
    const registry = createContributionRegistry();
    registry.registerManifest("broken", {
      name: "broken",
      version: "0.0.0",
      contractVersion: 0,
      permissions: [],
      contentRenderers: [
        {
          kinds: ["document"],
          renderAgentContent: async (object) => ({
            content: object.title,
            truncated: null,
          }),
          renderDelta: async () => {
            throw new Error("exploded");
          },
        },
      ],
    });

    await expect(
      resolveContentDelta(
        registry,
        producedObject({ title: "old" }),
        producedObject({ title: "new" }),
      ),
    ).resolves.toBeNull();
  });
});

describe("commandPaletteItemsFromRegistry / invokePluginPaletteEntry", () => {
  it("maps every registered palette entry onto a verb-kind command palette item, prefixed to avoid collisions", () => {
    const registry = createContributionRegistry();
    registry.registerManifest("filesystem", {
      name: "filesystem",
      version: "0.0.0",
      contractVersion: 0,
      permissions: [],
      paletteEntries: [
        {
          id: "browse",
          label: "Browse files",
          description: "browse the filesystem",
          invoke: async () => {},
        },
      ],
    });

    expect(commandPaletteItemsFromRegistry(registry)).toEqual([
      { id: "plugin:browse", label: "Browse files", kind: "verb" },
    ]);
  });

  it("invokes a matching plugin entry and reports it handled", async () => {
    const registry = createContributionRegistry();
    const invoke = vi.fn(async () => {});
    registry.registerManifest("filesystem", {
      name: "filesystem",
      version: "0.0.0",
      contractVersion: 0,
      permissions: [],
      paletteEntries: [
        { id: "browse", label: "Browse files", description: "", invoke },
      ],
    });

    const handled = await invokePluginPaletteEntry(registry, "plugin:browse");
    expect(handled).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("reports unhandled for an id that isn't a plugin entry, without calling anything", async () => {
    const registry = createContributionRegistry();
    const handled = await invokePluginPaletteEntry(registry, "verb-clear-log");
    expect(handled).toBe(false);
  });

  it("reports unhandled for a plugin-prefixed id nothing currently registers", async () => {
    const registry = createContributionRegistry();
    const handled = await invokePluginPaletteEntry(registry, "plugin:missing");
    expect(handled).toBe(false);
  });
});
