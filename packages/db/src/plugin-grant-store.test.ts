import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { removeStateDir } from "./remove-state-dir.js";
import { manualClock, type ManualClock } from "@plotroom/core/testing";
import { openDatabase, type PlotroomDatabase } from "./client.js";
import { PluginGrantStore } from "./plugin-grant-store.js";

let dir: string;
let state: PlotroomDatabase;
let clock: ManualClock;
let grants: PluginGrantStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-plugin-grants-"));
  state = openDatabase({ stateDir: dir });
  clock = manualClock();
  grants = new PluginGrantStore(state, clock.now);
});

afterEach(() => {
  removeStateDir(dir);
});

describe("PluginGrantStore", () => {
  it("records an answer per (plugin, permission)", () => {
    grants.answer({
      pluginId: "github",
      permissionId: "github-token",
      state: "granted",
    });
    grants.answer({
      pluginId: "github",
      permissionId: "github-network",
      state: "denied",
    });
    grants.answer({
      pluginId: "coding-git",
      permissionId: "workspace-files",
      state: "granted",
    });

    expect(grants.forPlugin("github")).toEqual(
      expect.arrayContaining([
        {
          pluginId: "github",
          permissionId: "github-token",
          state: "granted",
          answeredAt: clock.now(),
        },
        {
          pluginId: "github",
          permissionId: "github-network",
          state: "denied",
          answeredAt: clock.now(),
        },
      ]),
    );
    expect(grants.forPlugin("github")).toHaveLength(2);
    expect(grants.list()).toHaveLength(3);
  });

  it("replaces an answer rather than accumulating rows", () => {
    grants.answer({
      pluginId: "github",
      permissionId: "github-token",
      state: "granted",
    });
    clock.advance(5);
    grants.answer({
      pluginId: "github",
      permissionId: "github-token",
      state: "denied",
    });

    expect(grants.forPlugin("github")).toEqual([
      {
        pluginId: "github",
        permissionId: "github-token",
        state: "denied",
        answeredAt: clock.now(),
      },
    ]);
  });

  it("removes a grant rather than writing a third state, so it is never-asked again", () => {
    grants.answer({
      pluginId: "github",
      permissionId: "github-token",
      state: "granted",
    });
    grants.remove("github", "github-token");

    // Absent is `never-asked`: the state that raises through §6.6 next time.
    expect(grants.forPlugin("github")).toEqual([]);
  });

  it("clears everything a removed plugin was answered about", () => {
    grants.answer({
      pluginId: "github",
      permissionId: "github-token",
      state: "granted",
    });
    grants.answer({
      pluginId: "github",
      permissionId: "github-network",
      state: "granted",
    });
    grants.answer({
      pluginId: "coding-git",
      permissionId: "workspace-files",
      state: "granted",
    });

    grants.clear("github");

    expect(grants.list().map((grant) => grant.pluginId)).toEqual([
      "coding-git",
    ]);
  });
});
