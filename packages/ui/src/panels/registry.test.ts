import { describe, expect, it } from "vitest";

import {
  createPanelRegistry,
  definePanel,
  nextOpenPanelId,
  withPanelState,
} from "./registry.js";

describe("createPanelRegistry", () => {
  it("registers and lists panels, including by plugins later — a registry, not a hardcoded list", () => {
    const registry = createPanelRegistry();
    registry.register(
      definePanel({
        id: "notes",
        title: "Notes",
        initialState: null,
        render: () => null,
      }),
    );
    registry.register(
      definePanel({
        id: "plugin-panel",
        title: "A plugin's panel",
        initialState: {},
        render: () => null,
      }),
    );
    expect(
      registry
        .list()
        .map((p) => p.id)
        .sort(),
    ).toEqual(["notes", "plugin-panel"]);
  });

  it("get returns the registered panel by id, or undefined", () => {
    const registry = createPanelRegistry();
    registry.register(
      definePanel({
        id: "notes",
        title: "Notes",
        initialState: null,
        render: () => null,
      }),
    );
    expect(registry.get("notes")?.title).toBe("Notes");
    expect(registry.get("missing")).toBeUndefined();
  });

  it("unregister removes a panel", () => {
    const registry = createPanelRegistry();
    registry.register(
      definePanel({
        id: "notes",
        title: "Notes",
        initialState: null,
        render: () => null,
      }),
    );
    registry.unregister("notes");
    expect(registry.get("notes")).toBeUndefined();
    expect(registry.list()).toEqual([]);
  });

  it("accepts initial panels at construction", () => {
    const registry = createPanelRegistry([
      definePanel({
        id: "warnings",
        title: "Warnings",
        initialState: null,
        render: () => null,
      }),
    ]);
    expect(registry.get("warnings")?.id).toBe("warnings");
  });
});

describe("nextOpenPanelId", () => {
  it("opens a panel that was closed", () => {
    expect(nextOpenPanelId(null, "notes")).toBe("notes");
  });

  it("switches to a different panel — one open at a time", () => {
    expect(nextOpenPanelId("notes", "warnings")).toBe("warnings");
  });

  it("closes the currently-open panel when its own icon is clicked again", () => {
    expect(nextOpenPanelId("notes", "notes")).toBeNull();
  });
});

describe("withPanelState", () => {
  it("persists a panel's state independent of others, so closing is cheap", () => {
    let bag = withPanelState({}, "notes", { draft: "hello" });
    bag = withPanelState(bag, "warnings", { scrollTop: 42 });
    expect(bag["notes"]).toEqual({ draft: "hello" });
    expect(bag["warnings"]).toEqual({ scrollTop: 42 });

    // "Reopening" a panel is just reading its entry back out of the bag,
    // never resetting it — the bag is untouched by opening/closing per se.
    const reopened = bag["notes"];
    expect(reopened).toEqual({ draft: "hello" });
  });

  it("does not mutate the original bag", () => {
    const original = { notes: "a" };
    const next = withPanelState(original, "notes", "b");
    expect(original).toEqual({ notes: "a" });
    expect(next).toEqual({ notes: "b" });
  });
});
