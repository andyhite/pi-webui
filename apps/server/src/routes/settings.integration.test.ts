import { afterEach, describe, expect, it } from "vitest";
import { at, boot, cleanupHarnesses, list } from "../testing/harness.js";

/**
 * Settings (§11, §8, Epic 8.3): grouped, searchable, applied without a
 * restart; environment variables only supply defaults.
 *
 * Drives the real app over HTTP, the same convention as every other Batch 6
 * server suite: what this proves about a live setting taking effect is true
 * of a real operator's write, not only of the unit that applies it.
 */

afterEach(cleanupHarnesses);

describe("settings (§11, Epic 8.3)", () => {
  it("lists every setting grouped, with its default and whether it is overridden", async () => {
    const harness = await boot();
    const found = await harness.ok("/settings");
    const settings = list(found, "settings");

    const concurrency = settings.find(
      (entry) => at(entry, "key") === "concurrencyLimit",
    );
    expect(concurrency).toBeDefined();
    expect(at(concurrency, "group")).toBe("Runs");
    expect(at(concurrency, "overridden")).toBe(false);
    expect(at(concurrency, "appliesWithoutRestart")).toBe(true);

    const host = settings.find((entry) => at(entry, "key") === "host");
    expect(at(host, "appliesWithoutRestart")).toBe(false);
    expect(typeof at(host, "restartReason")).toBe("string");
  });

  it("searches by label, description, or group", async () => {
    const harness = await boot();
    const found = await harness.ok("/settings?q=concurrency");
    const keys = list(found, "settings").map((entry) => at(entry, "key"));

    expect(keys).toContain("concurrencyLimit");
    expect(keys).not.toContain("host");
  });

  it("a write takes effect immediately, without a restart, when the catalog says it can", async () => {
    const harness = await boot();

    const before = await harness.ok("/fleet");
    expect(at(before, "concurrency.limit")).toBe(4);

    const written = await harness.ok("/settings/concurrencyLimit", {
      method: "PUT",
      body: { value: 2 },
    });
    expect(at(written, "setting.value")).toBe(2);
    expect(at(written, "setting.overridden")).toBe(true);
    expect(at(written, "setting.appliesWithoutRestart")).toBe(true);

    const after = await harness.ok("/fleet");
    expect(at(after, "concurrency.limit")).toBe(2);
  });

  it("reverting an override restores the env-derived default, live", async () => {
    const harness = await boot();

    await harness.ok("/settings/concurrencyLimit", {
      method: "PUT",
      body: { value: 1 },
    });
    expect(at(await harness.ok("/fleet"), "concurrency.limit")).toBe(1);

    const reverted = await harness.call("/settings/concurrencyLimit", {
      method: "DELETE",
    });
    expect(reverted.status).toBe(200);
    expect(at(reverted.body, "setting.overridden")).toBe(false);
    expect(at(reverted.body, "setting.value")).toBe(4);

    expect(at(await harness.ok("/fleet"), "concurrency.limit")).toBe(4);
  });

  it("names honestly, per write, that a restart-only setting did not take effect yet", async () => {
    const harness = await boot();

    const written = await harness.ok("/settings/host", {
      method: "PUT",
      body: { value: "0.0.0.0" },
    });

    expect(at(written, "setting.appliesWithoutRestart")).toBe(false);
    expect(typeof at(written, "setting.restartReason")).toBe("string");
    expect(at(written, "setting.value")).toBe("0.0.0.0");
  });

  it("refuses a session actor's write and revert (principle 1)", async () => {
    const harness = await boot();

    const write = await harness.call("/settings/concurrencyLimit", {
      method: "PUT",
      body: { value: 2 },
      actor: "session:sess_1",
    });
    expect(write.status).toBe(403);

    const remove = await harness.call("/settings/concurrencyLimit", {
      method: "DELETE",
      actor: "session:sess_1",
    });
    expect(remove.status).toBe(403);
  });

  it("a session may still read settings (§8's 'see what remains', applied here)", async () => {
    const harness = await boot();
    const read = await harness.call("/settings/concurrencyLimit", {
      actor: "session:sess_1",
    });
    // Every catalog entry here is `humanOnly`, deliberately (this batch's
    // conservative default over infra-shaped settings) — so a session's read
    // is refused too, exactly like `/api/log-level`'s existing precedent.
    expect(read.status).toBe(403);
  });

  it("has no stateDir entry: a stored value cannot relocate the store that holds it (§12)", async () => {
    const harness = await boot();

    const found = await harness.ok("/settings");
    const keys = list(found, "settings").map((entry) => at(entry, "key"));
    expect(keys).not.toContain("stateDir");

    const read = await harness.call("/settings/stateDir");
    expect(read.status).toBe(404);
  });

  it("refuses an unknown key with a 404, and a malformed value with a 400", async () => {
    const harness = await boot();

    const unknown = await harness.call("/settings/not-a-real-setting");
    expect(unknown.status).toBe(404);

    const malformed = await harness.call("/settings/concurrencyLimit", {
      method: "PUT",
      body: { value: "not-a-number" },
    });
    expect(malformed.status).toBe(400);
  });

  it("refuses a concurrency limit of zero, the same bound the environment variable refuses", async () => {
    const harness = await boot();

    // Zero is the one that matters: it is not merely out of range, it would
    // refuse every admission for ever, which is the failure the limit exists to
    // prevent (AGENTS.md's recorded decision).
    for (const value of [0, -1, 2.5]) {
      const refused = await harness.call("/settings/concurrencyLimit", {
        method: "PUT",
        body: { value },
      });
      expect(refused.status, String(value)).toBe(400);
      expect(String(at(refused.body, "error.message"))).toContain("at least 1");
    }

    // Nothing was stored, so the queue still admits work under the default.
    const read = await harness.ok("/settings/concurrencyLimit");
    expect(at(read, "setting.overridden")).toBe(false);
    expect(at(await harness.ok("/fleet"), "concurrency.limit")).toBe(4);
  });

  it("refuses a negative interval, and still allows zero where zero means 'no schedule'", async () => {
    const harness = await boot();

    const refused = await harness.call("/settings/compactionIntervalSeconds", {
      method: "PUT",
      body: { value: -1 },
    });
    expect(refused.status).toBe(400);

    // Zero disables the schedule and leaves the on-demand sweep available; it is
    // a legal value, not a lower bound violation.
    const disabled = await harness.call("/settings/compactionIntervalSeconds", {
      method: "PUT",
      body: { value: 0 },
    });
    expect(disabled.status).toBe(200);
  });

  it("ignores a stored value outside its bound rather than booting wedged under it", async () => {
    const first = await boot();
    const stateDir = first.stateDir;
    await first.handle.close();

    // Exactly what an older build's accepted write left behind: a stored zero,
    // which no current write could produce. Written under the store's own key,
    // because the point is that this process must survive reading it back.
    const { openDatabase, SettingsStore } = await import("@plotroom/db");
    const state = openDatabase({ stateDir });
    new SettingsStore(state).set("concurrencyLimit", JSON.stringify(0));
    state.close();

    // The boot succeeds and runs the env-derived default; the queue admits work.
    const second = await boot({ logLevel: "warn" }, { stateDir });
    expect(at(await second.ok("/fleet"), "concurrency.limit")).toBe(4);

    // And it says so rather than dropping it quietly.
    const logs = list(await second.ok("/logs?level=warn"), "entries");
    const ignored = logs.find(
      (entry) => at(entry, "msg") === "ignored a stored setting",
    );
    expect(ignored).toBeDefined();
    expect(at(ignored, "key")).toBe("concurrencyLimit");
    expect(String(at(ignored, "reason"))).toContain("at least 1");
  });

  it("a persisted override survives a restart of the same state directory", async () => {
    const first = await boot();
    await first.ok("/settings/concurrencyLimit", {
      method: "PUT",
      body: { value: 3 },
    });
    await first.handle.close();

    const second = await boot({}, { stateDir: first.stateDir });
    const read = await second.ok("/settings/concurrencyLimit");
    expect(at(read, "setting.value")).toBe(3);
    expect(at(read, "setting.overridden")).toBe(true);
    expect(at(await second.ok("/fleet"), "concurrency.limit")).toBe(3);
  });
});
