/**
 * Lifecycle without a restart (§10.2): install, enable, disable, remove — and a
 * plugin that cannot load leaving the product entirely up.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CoreId } from "./contract/ids.js";
import {
  PluginNotInstalledError,
  PluginRegistry,
  discoverPluginEntries,
  type PluginRegistryEvent,
} from "./registry.js";

const fixture = (name: string): URL =>
  new URL(`./test-fixtures/${name}`, import.meta.url);

const coreId = (value: string): CoreId => value as unknown as CoreId;

const actor = {
  sessionId: coreId("sess_1"),
  workstreamId: coreId("ws_1"),
};

const registries: PluginRegistry[] = [];

const newRegistry = (events?: PluginRegistryEvent[]): PluginRegistry => {
  const registry = new PluginRegistry({
    now: () => 1_000,
    ...(events === undefined
      ? {}
      : { onEvent: (event: PluginRegistryEvent) => events.push(event) }),
  });
  registries.push(registry);
  return registry;
};

afterEach(async () => {
  await Promise.all(registries.splice(0).map((r) => r.disposeAll()));
});

describe("the four lifecycle verbs (§10.2)", () => {
  it("installs a plugin by reading its manifest, without running it", async () => {
    const events: PluginRegistryEvent[] = [];
    const registry = newRegistry(events);

    const result = await registry.install(
      fixture("test-plugin/index.ts"),
      "in-box",
    );

    expect(result.installed).toBe(true);
    const record = registry.get("test-plugin");
    expect(record?.state).toBe("installed");
    expect(record?.origin).toBe("in-box");
    expect(record?.health).toBeNull();
    expect(registry.host("test-plugin")).toBeNull();
    expect(events).toEqual([
      {
        type: "plugin",
        pluginId: "test-plugin",
        state: "installed",
        health: null,
        at: 1_000,
      },
    ]);
  });

  it("enables, serves calls, disables, and re-enables without a restart", async () => {
    const registry = newRegistry();
    await registry.install(fixture("test-plugin/index.ts"));

    await registry.enable("test-plugin");
    expect(registry.get("test-plugin")?.state).toBe("enabled");
    const result = await registry.host("test-plugin")?.invoke(
      {
        kind: "tool.call",
        contributionId: "fixture_echo",
        input: { text: "hi" },
      },
      { actor },
    );
    expect(result?.ok).toBe(true);

    await registry.disable("test-plugin");
    expect(registry.get("test-plugin")?.state).toBe("disabled");
    expect(registry.host("test-plugin")).toBeNull();

    await registry.enable("test-plugin");
    expect(registry.host("test-plugin")).not.toBeNull();
  });

  it("removes a plugin without deleting anything on disk", async () => {
    const registry = newRegistry();
    await registry.install(fixture("test-plugin/index.ts"));
    await registry.enable("test-plugin");

    await registry.remove("test-plugin");

    expect(registry.get("test-plugin")).toBeNull();
    expect(registry.list()).toEqual([]);
    // The entry file is still there: a second install finds it again.
    const again = await registry.install(fixture("test-plugin/index.ts"));
    expect(again.installed).toBe(true);
  });

  it("refuses to enable a plugin nobody installed", async () => {
    const registry = newRegistry();

    await expect(registry.enable("ghost")).rejects.toBeInstanceOf(
      PluginNotInstalledError,
    );
  });
});

describe("a broken plugin never takes the product down (§10.2)", () => {
  it("reports an install failure instead of throwing", async () => {
    const registry = newRegistry();

    const result = await registry.install(fixture("throws-on-load-plugin.ts"));

    expect(result.installed).toBe(false);
    if (!result.installed) {
      expect(result.failure.reason).toBe("exploded while loading");
    }
    expect(registry.list()).toEqual([]);
  });

  it("keeps a healthy plugin serving while a broken one degrades", async () => {
    const registry = newRegistry();
    await registry.install(fixture("test-plugin/index.ts"));
    await registry.install(fixture("crashing-plugin.ts"));
    process.env["PLOTROOM_TEST_CRASH_COUNTER"] = join(
      await mkdtemp(join(tmpdir(), "plotroom-registry-")),
      "attempts",
    );
    await writeFile(process.env["PLOTROOM_TEST_CRASH_COUNTER"], "");

    await registry.enable("test-plugin");
    await registry.enable("crasher");
    await registry
      .host("crasher")
      ?.invoke(
        { kind: "tool.call", contributionId: "maybe_crash", input: {} },
        { actor },
      )
      .catch(() => undefined);

    const healthy = await registry.host("test-plugin")?.invoke(
      {
        kind: "tool.call",
        contributionId: "fixture_echo",
        input: { text: "up" },
      },
      { actor },
    );
    expect(healthy?.content).toBe('{"text":"up"}');
    expect(registry.get("crasher")?.state).toBe("enabled");
  });

  it("publishes the health change so the server can surface it", async () => {
    const events: PluginRegistryEvent[] = [];
    const registry = newRegistry(events);
    await registry.install(fixture("test-plugin/index.ts"));
    await registry.enable("test-plugin");

    const states = events.map((event) => event.state);
    expect(states).toEqual(["installed", "enabled", "enabled"]);
    expect(events.at(-1)?.health?.status).toBe("ready");
  });
});

describe("directory distribution (§10.2)", () => {
  it("installs every plugin in a configured directory and reports the rest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "plotroom-plugins-"));
    await mkdir(join(directory, "demo"));
    await writeFile(
      join(directory, "demo", "index.js"),
      [
        "export default {",
        '  id: "demo",',
        '  name: "Demo",',
        '  version: "0.1.0",',
        "  contractVersion: 1,",
        "  permissions: [],",
        "  contributions: {",
        '    themes: [{ id: "demo-theme", name: "Demo", tokens: {} }],',
        "  },",
        "};",
        "",
      ].join("\n"),
    );
    await mkdir(join(directory, "not-a-plugin-directory"));
    const registry = newRegistry();

    const result = await registry.installFromDirectory(directory);

    expect(result.installed.map((record) => record.id)).toEqual(["demo"]);
    expect(result.installed[0]?.origin).toBe("directory");
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.reason).toMatch(/no plugin entry file/);
  });

  it("reports an unreadable plugins directory as empty rather than throwing", async () => {
    const discovered = await discoverPluginEntries(
      join(tmpdir(), "plotroom-does-not-exist"),
    );

    expect(discovered).toEqual({ entries: [], unreadable: [] });
  });
});
