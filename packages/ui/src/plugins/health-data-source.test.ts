import { describe, expect, it } from "vitest";

import {
  createEmptyPluginHealthDataSource,
  createFixturePluginHealthDataSource,
} from "./health-data-source.js";
import type { PluginHealthEntry } from "./types.js";

const entry: PluginHealthEntry = {
  pluginId: "filesystem",
  name: "Filesystem",
  lifecycle: { status: "ready", reason: null },
  integration: null,
};

describe("createFixturePluginHealthDataSource", () => {
  it("load resolves with the fixed entries", async () => {
    const source = createFixturePluginHealthDataSource([entry]);
    expect(await source.load()).toEqual([entry]);
  });

  it("subscribe never fires — fixtures never change", () => {
    const source = createFixturePluginHealthDataSource([entry]);
    let calls = 0;
    const unsubscribe = source.subscribe(() => {
      calls += 1;
    });
    unsubscribe();
    expect(calls).toBe(0);
  });
});

describe("createEmptyPluginHealthDataSource", () => {
  it("load resolves with zero entries — an honest absence, never a manufactured row", async () => {
    const source = createEmptyPluginHealthDataSource();
    expect(await source.load()).toEqual([]);
  });

  it("subscribe never fires — there is no live event source behind it yet", () => {
    const source = createEmptyPluginHealthDataSource();
    let calls = 0;
    const unsubscribe = source.subscribe(() => {
      calls += 1;
    });
    unsubscribe();
    expect(calls).toBe(0);
  });
});
