import { describe, expect, it } from "vitest";

import { createFixturePluginHealthDataSource } from "./health-data-source.js";
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
