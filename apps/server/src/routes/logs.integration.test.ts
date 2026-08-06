import { expect, afterEach, describe, it } from "bun:test";
import { at, boot, cleanupHarnesses, list } from "../testing/harness.js";

/**
 * The structured log, queryable (§8, Epic 8.3).
 *
 * Drives the real app: the server's own boot-time logging and every request
 * this suite makes are what populate the buffer, so what this proves about
 * filtering and the drop notice is true of the process's real log, not a
 * fixture standing in for it.
 */

afterEach(cleanupHarnesses);

describe("the structured log (§8, Epic 8.3)", () => {
  it("is queryable, and reports it is bounded rather than pretending otherwise", async () => {
    // The harness defaults to `error` so ordinary suites stay quiet; these
    // tests need the info-level lines (boot, requests) the ring buffer would
    // otherwise never see.
    const harness = await boot({ logLevel: "info" });

    const read = await harness.ok("/logs");
    const entries = list(read, "entries");

    expect(entries.length).toBeGreaterThan(0);
    expect(typeof at(read, "capacity")).toBe("number");
    expect(at(read, "droppedTotal")).toBe(0);
    // Boot logs at least one line this suite did not have to cause itself.
    expect(entries.some((e) => at(e, "msg") === "server started")).toBe(true);
  });

  it("filters by minimum level", async () => {
    const harness = await boot({ logLevel: "info" });
    const read = await harness.ok("/logs?level=error");
    const entries = list(read, "entries");

    expect(entries.every((e) => at(e, "level") === "error")).toBe(true);
  });

  it("filters by component — http traffic is tagged", async () => {
    const harness = await boot({ logLevel: "info" });
    await harness.ok("/workstreams", { method: "POST", body: {} });

    const read = await harness.ok("/logs?component=http");
    const entries = list(read, "entries");

    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => at(e, "component") === "http")).toBe(true);
    expect(
      entries.some(
        (e) =>
          at(e, "msg") === "request" && at(e, "path") === "/api/workstreams",
      ),
    ).toBe(true);
  });

  it("filters by sinceSeq, exclusive", async () => {
    const harness = await boot({ logLevel: "info" });
    const first = await harness.ok("/logs");
    const newestSeq = at(first, "newestSeq") as number;

    await harness.ok("/workstreams", { method: "POST", body: {} });
    const second = await harness.ok(`/logs?sinceSeq=${newestSeq}`);
    const entries = list(second, "entries");

    expect(entries.every((e) => (at(e, "seq") as number) > newestSeq)).toBe(
      true,
    );
    expect(entries.length).toBeGreaterThan(0);
  });

  it("refuses a session actor, like /api/log-level's existing precedent", async () => {
    const harness = await boot({ logLevel: "info" });
    const res = await harness.call("/logs", { actor: "session:sess_1" });
    expect(res.status).toBe(403);
  });
});
