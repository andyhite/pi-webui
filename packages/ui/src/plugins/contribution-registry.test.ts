import { describe, expect, it, vi } from "vitest";
import type {
  CardRenderer,
  ConceptKind,
  PluginManifest,
  ProducedObject,
} from "@plotroom/plugin-sdk";

import {
  commandPaletteItemsFromRegistry,
  createContributionRegistry,
  invokePluginPaletteEntry,
  resolveCardView,
  resolveContentDelta,
} from "./contribution-registry.js";

function manifest(
  overrides: Partial<PluginManifest["contributions"]> = {},
  manifestOverrides: Partial<PluginManifest> = {},
): PluginManifest {
  return {
    id: "filesystem",
    name: "filesystem",
    version: "0.0.0",
    contractVersion: 1,
    permissions: [],
    contributions: { ...overrides },
    ...manifestOverrides,
  };
}

function producedObject(
  overrides: Partial<ProducedObject> = {},
): ProducedObject {
  return {
    kind: "document",
    externalId: "ext_1",
    title: "a document",
    renderings: { card: "a document", summary: "a document", agentContent: "" },
    ...overrides,
  };
}

function cardRenderer(
  kinds: readonly ConceptKind[],
  renderCard: CardRenderer["renderCard"],
): CardRenderer {
  return { id: "card", kinds, renderCard };
}

describe("createContributionRegistry", () => {
  it("registers and lists manifests, including by plugins later — a registry, not a hardcoded list", () => {
    const registry = createContributionRegistry();
    registry.registerManifest("filesystem", manifest());
    expect(registry.listManifests()).toEqual([
      {
        pluginId: "filesystem",
        manifest: expect.objectContaining({ name: "filesystem" }),
      },
    ]);
  });

  it("refuses to register a manifest whose id disagrees with the caller's pluginId", () => {
    const registry = createContributionRegistry();
    expect(() =>
      registry.registerManifest(
        "filesystem",
        manifest({}, { id: "github", name: "github" }),
      ),
    ).toThrow(/pluginId "filesystem" but manifest\.id is "github"/);
  });

  it("unregisterManifest removes a manifest and everything it contributed", () => {
    const registry = createContributionRegistry();
    registry.registerManifest(
      "filesystem",
      manifest({
        cardRenderers: [
          cardRenderer(["document"], async () => ({
            title: "x",
            lines: [],
            actions: [],
          })),
        ],
      }),
    );
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
    registry.registerManifest(
      "filesystem",
      manifest({ cardRenderers: [renderer] }),
    );
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
    registry.registerManifest(
      "a",
      manifest({ cardRenderers: [first] }, { id: "a", name: "a" }),
    );
    registry.registerManifest(
      "b",
      manifest({ cardRenderers: [second] }, { id: "b", name: "b" }),
    );
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
    registry.registerManifest(
      "filesystem",
      manifest({ cardRenderers: [cardRenderer(["document"], renderCard)] }),
    );

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
    expect(renderCard).toHaveBeenCalledWith(
      expect.anything(),
      "compact",
      expect.objectContaining({ actor: null }),
    );

    const expanded = await resolveCardView(
      registry,
      producedObject(),
      "expanded",
    );
    expect(expanded?.title).toBe("title (expanded)");
  });

  it("degrades to null (never throws) when the registered renderer throws — the concept never renders broken", async () => {
    const registry = createContributionRegistry();
    registry.registerManifest(
      "broken",
      manifest(
        {
          cardRenderers: [
            cardRenderer(["document"], async () => {
              throw new Error("exploded");
            }),
          ],
        },
        { id: "broken", name: "broken" },
      ),
    );

    await expect(
      resolveCardView(registry, producedObject(), "compact"),
    ).resolves.toBeNull();
  });

  it("degrades to null when the registered renderer rejects", async () => {
    const registry = createContributionRegistry();
    registry.registerManifest(
      "broken",
      manifest(
        {
          cardRenderers: [
            cardRenderer(["document"], () => Promise.reject(new Error("nope"))),
          ],
        },
        { id: "broken", name: "broken" },
      ),
    );

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
      async (previous: ProducedObject, next: ProducedObject) => ({
        content: `${previous.title} -> ${next.title}`,
        truncated: null,
      }),
    );
    registry.registerManifest(
      "filesystem",
      manifest({
        contentRenderers: [
          {
            id: "content",
            kinds: ["document"],
            renderAgentContent: async (object) => ({
              content: object.title,
              truncated: null,
            }),
            renderDelta,
          },
        ],
      }),
    );

    const result = await resolveContentDelta(
      registry,
      producedObject({ title: "old" }),
      producedObject({ title: "new" }),
    );
    expect(result).toEqual({ content: "old -> new", truncated: null });
    expect(renderDelta).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ actor: null }),
    );
  });

  it("degrades to null when the registered content renderer throws", async () => {
    const registry = createContributionRegistry();
    registry.registerManifest(
      "broken",
      manifest(
        {
          contentRenderers: [
            {
              id: "content",
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
        },
        { id: "broken", name: "broken" },
      ),
    );

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
    registry.registerManifest(
      "filesystem",
      manifest({
        paletteEntries: [
          {
            id: "browse",
            label: "Browse files",
            description: "browse the filesystem",
            invoke: async () => {},
          },
        ],
      }),
    );

    expect(commandPaletteItemsFromRegistry(registry)).toEqual([
      { id: "plugin:browse", label: "Browse files", kind: "verb" },
    ]);
  });

  it("invokes a matching plugin entry and reports it handled", async () => {
    const registry = createContributionRegistry();
    const invoke = vi.fn(async () => {});
    registry.registerManifest(
      "filesystem",
      manifest({
        paletteEntries: [
          { id: "browse", label: "Browse files", description: "", invoke },
        ],
      }),
    );

    const handled = await invokePluginPaletteEntry(registry, "plugin:browse");
    expect(handled).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ actor: null }),
    );
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
