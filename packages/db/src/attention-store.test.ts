import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { humanAuthor, triageStatus } from "@plotroom/core";
import { manualClock, type ManualClock } from "@plotroom/core/testing";
import { AttentionStore } from "./attention-store.js";
import { openDatabase, type PlotroomDatabase } from "./client.js";

let dir: string;
let state: PlotroomDatabase;
let clock: ManualClock;
let store: AttentionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-attention-"));
  state = openDatabase({ stateDir: dir });
  clock = manualClock();
  store = new AttentionStore(state, clock.now);
});

afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the triage ledger", () => {
  it("survives a restart, which is the whole reason it is a table", () => {
    store.triage({
      itemId: "approval:appr-1",
      verb: "mute",
      at: 100,
      by: humanAuthor,
    });

    const reopened = new AttentionStore(
      openDatabase({ stateDir: dir }),
      clock.now,
    );
    expect(
      triageStatus(reopened.ledger().get("approval:appr-1"), 100_000),
    ).toBe("muted");
  });

  it("keeps a snooze's return time, and reports it active once elapsed", () => {
    store.triage({
      itemId: "question:q-1",
      verb: "snooze",
      at: 100,
      by: humanAuthor,
      snoozedUntil: 500,
    });

    const record = store.record("question:q-1");
    expect(record?.snoozedUntil).toBe(500);
    expect(triageStatus(record, 400)).toBe("snoozed");
    expect(triageStatus(record, 500)).toBe("active");
  });

  it("replaces a verb rather than accumulating them", () => {
    store.triage({
      itemId: "drift:node-1:obj-1",
      verb: "acknowledge",
      at: 100,
      by: humanAuthor,
      baselineVersionId: "ver-1" as never,
    });
    store.triage({
      itemId: "drift:node-1:obj-1",
      verb: "mute",
      at: 200,
      by: humanAuthor,
    });

    expect(store.ledger().size).toBe(1);
    expect(store.record("drift:node-1:obj-1")?.verb).toBe("mute");
  });

  it("keeps one consumer's baseline out of another's", () => {
    store.triage({
      itemId: "drift:node-1:obj-1",
      verb: "mute",
      at: 100,
      by: humanAuthor,
    });
    store.triage({
      itemId: "drift:node-1:obj-1",
      consumer: "node-1",
      verb: "acknowledge",
      at: 100,
      by: humanAuthor,
      baselineVersionId: "ver-2" as never,
    });

    expect(store.record("drift:node-1:obj-1")?.verb).toBe("mute");
    expect(store.record("drift:node-1:obj-1", "node-1")?.verb).toBe(
      "acknowledge",
    );
  });

  it("clears a decision, because a mute you regret is recoverable", () => {
    store.triage({
      itemId: "health:idle:sess-1",
      verb: "mute",
      at: 100,
      by: humanAuthor,
    });
    store.clearTriage("health:idle:sess-1");
    expect(store.record("health:idle:sess-1")).toBeUndefined();
  });
});

describe("outbound routes", () => {
  it("stores a route against a state, with health that starts empty", () => {
    const route = store.createRoute({
      id: "route-1",
      name: "chat",
      state: "blocked",
      url: "https://example.invalid/hook",
      enabled: true,
      at: 100,
    });

    expect(route.destination).toEqual({
      kind: "webhook",
      url: "https://example.invalid/hook",
    });
    expect(route.health.consecutiveFailures).toBe(0);
    expect(store.routes()).toHaveLength(1);
  });

  it("counts consecutive failures and forgets them on the next success", () => {
    store.createRoute({
      id: "route-1",
      name: "chat",
      state: "blocked",
      url: "https://example.invalid/hook",
      enabled: true,
      at: 100,
    });

    store.recordDelivery("route-1", { ok: false, reason: "404" }, 110);
    const twice = store.recordDelivery(
      "route-1",
      { ok: false, reason: "404" },
      120,
    );
    expect(twice.health.consecutiveFailures).toBe(2);
    expect(twice.health.lastFailureReason).toBe("404");

    const recovered = store.recordDelivery("route-1", { ok: true }, 130);
    expect(recovered.health.consecutiveFailures).toBe(0);
    expect(recovered.health.lastSuccessAt).toBe(130);
    // The failure itself is not erased: when it last broke is still a fact.
    expect(recovered.health.lastFailureAt).toBe(120);
  });

  it("remembers what it already fired, and forgets an item that left", () => {
    store.createRoute({
      id: "route-1",
      name: "chat",
      state: "anything",
      url: "https://example.invalid/hook",
      enabled: true,
      at: 100,
    });

    store.saveFired("route-1", new Set(["approval:appr-1"]), 110);
    expect([...store.firedItems("route-1")]).toEqual(["approval:appr-1"]);

    store.saveFired("route-1", new Set(), 120);
    expect([...store.firedItems("route-1")]).toEqual([]);
  });

  it("takes its fires with it when the route is deleted", () => {
    store.createRoute({
      id: "route-1",
      name: "chat",
      state: "anything",
      url: "https://example.invalid/hook",
      enabled: true,
      at: 100,
    });
    store.saveFired("route-1", new Set(["approval:appr-1"]), 110);
    store.deleteRoute("route-1");

    expect(store.routes()).toEqual([]);
    expect([...store.firedItems("route-1")]).toEqual([]);
  });
});
