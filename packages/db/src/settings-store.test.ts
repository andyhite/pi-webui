import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { manualClock, type ManualClock } from "@plotroom/core/testing";
import { openDatabase, type PlotroomDatabase } from "./client.js";
import { SettingsStore } from "./settings-store.js";

let dir: string;
let state: PlotroomDatabase;
let clock: ManualClock;
let settings: SettingsStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-settings-"));
  state = openDatabase({ stateDir: dir });
  clock = manualClock();
  settings = new SettingsStore(state, clock.now);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SettingsStore", () => {
  it("has no row for a key nobody overrode yet", () => {
    expect(settings.get("logLevel")).toBeUndefined();
    expect(settings.list()).toEqual([]);
  });

  it("writes an override and reads it back", () => {
    settings.set("logLevel", JSON.stringify("debug"));

    expect(settings.get("logLevel")).toEqual({
      key: "logLevel",
      valueJson: JSON.stringify("debug"),
      updatedAt: clock.now(),
    });
  });

  it("overwrites rather than accumulating a second row for the same key", () => {
    settings.set("concurrencyLimit", JSON.stringify(4));
    clock.advance(10);
    settings.set("concurrencyLimit", JSON.stringify(8));

    expect(settings.list()).toHaveLength(1);
    expect(settings.get("concurrencyLimit")).toEqual({
      key: "concurrencyLimit",
      valueJson: JSON.stringify(8),
      updatedAt: clock.now(),
    });
  });

  it("removing an override reverts to the env-derived default: absence, not a third state", () => {
    settings.set("logLevel", JSON.stringify("debug"));
    settings.remove("logLevel");

    expect(settings.get("logLevel")).toBeUndefined();
  });

  it("lists every overridden key", () => {
    settings.set("logLevel", JSON.stringify("debug"));
    settings.set("concurrencyLimit", JSON.stringify(2));

    expect(
      settings
        .list()
        .map((row) => row.key)
        .sort(),
    ).toEqual(["concurrencyLimit", "logLevel"]);
  });
});
