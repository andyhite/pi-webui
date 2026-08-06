import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { manualClock, type ManualClock } from "@plotroom/core/testing";
import { openDatabase, type PlotroomDatabase } from "./client.js";
import { IntegrationStore } from "./integration-store.js";

let dir: string;
let state: PlotroomDatabase;
let clock: ManualClock;
let store: IntegrationStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-integrations-"));
  state = openDatabase({ stateDir: dir });
  clock = manualClock();
  store = new IntegrationStore(state, clock.now);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function connect() {
  return store.connect({
    pluginId: "fake-plugin",
    producerId: "fake-tickets",
    name: "Fake tickets",
    system: "fake",
  });
}

describe("IntegrationStore", () => {
  it("connects with a live connection and no history yet", () => {
    const integration = connect();
    expect(integration.connectionState).toBe("connected");
    expect(integration.lastRefreshAt).toBeNull();
    expect(integration.lastBrokenReason).toBeNull();
    expect(store.get(integration.id)).toEqual(integration);
    expect(store.list().map((one) => one.id)).toEqual([integration.id]);
  });

  it("updates scoping without touching connection state (§9.1: no restart)", () => {
    const integration = connect();
    clock.advance(5);
    const updated = store.updateScoping(integration.id, 'project = "OXY"');
    expect(updated.scope).toBe('project = "OXY"');
    expect(updated.connectionState).toBe("connected");
    expect(updated.updatedAt).toBe(integration.createdAt + 5);
  });

  it("records a refresh, and a broken connection is a fact rather than a guess", () => {
    const integration = connect();
    clock.advance(10);
    const refreshed = store.markRefreshed(integration.id);
    expect(refreshed.lastRefreshAt).toBe(integration.createdAt + 10);
    expect(refreshed.connectionState).toBe("connected");

    clock.advance(10);
    const broken = store.markBroken(integration.id, "authentication failed");
    expect(broken.connectionState).toBe("broken");
    expect(broken.lastBrokenReason).toBe("authentication failed");
    expect(broken.lastBrokenAt).toBe(integration.createdAt + 20);

    // A refresh that succeeds afterwards clears the broken state — the most
    // recent evidence wins (§9.3).
    clock.advance(10);
    const recovered = store.markRefreshed(integration.id);
    expect(recovered.connectionState).toBe("connected");
    expect(recovered.lastBrokenReason).toBeNull();
    expect(recovered.lastBrokenAt).toBeNull();
  });

  it("disconnects without deleting the row", () => {
    const integration = connect();
    const disconnected = store.disconnect(integration.id);
    expect(disconnected.connectionState).toBe("disconnected");
    expect(store.connected()).toEqual([]);
  });

  it("lists only connected integrations as due for a scheduled refresh", () => {
    const a = connect();
    const b = store.connect({
      pluginId: "fake-plugin",
      producerId: "fake-tickets-2",
      name: "Second",
      system: "fake",
    });
    store.disconnect(b.id);
    expect(store.connected().map((one) => one.id)).toEqual([a.id]);
  });
});
