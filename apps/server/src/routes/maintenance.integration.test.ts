import { expect } from "vitest";
import { afterEach, describe, it } from "bun:test";
import { boot, cleanupHarnesses } from "../testing/harness.js";

/**
 * Durability, portability, and cleanup as endpoints (§12, Epic 2.3) —
 * specifically the actor gate none of them had (#189).
 *
 * Every route here is declared tool-less in `catalog.test.ts`'s
 * `OPERATOR_ONLY_ROUTES`, which means no catalog-derived middleware — not the
 * destruction guard, not the session-lineage guard — ever reaches them. The
 * route's own actor check is the only gate there is, so this suite proves it
 * exists rather than trusting the declaration.
 */

afterEach(cleanupHarnesses);

describe("maintenance routes refuse a session actor (§12, #189)", () => {
  it("GET /maintenance/state", async () => {
    const harness = await boot();
    const res = await harness.call("/maintenance/state", {
      actor: "session:sess_1",
    });
    expect(res.status).toBe(403);
  });

  it("GET /reset/plan", async () => {
    const harness = await boot();
    const res = await harness.call("/reset/plan?scope=everything", {
      actor: "session:sess_1",
    });
    expect(res.status).toBe(403);
  });

  it("POST /reset — the verb #189 found wiping the store with nobody asked", async () => {
    const harness = await boot();
    const res = await harness.call("/reset", {
      method: "POST",
      body: { scope: "everything", confirm: true },
      actor: "session:sess_1",
    });
    expect(res.status).toBe(403);

    // Nothing was removed: the refusal happens before the plan is even read.
    const state = await harness.ok("/maintenance/state");
    expect(state).toBeTruthy();
  });

  it("POST /maintenance/compact", async () => {
    const harness = await boot();
    const res = await harness.call("/maintenance/compact", {
      method: "POST",
      actor: "session:sess_1",
    });
    expect(res.status).toBe(403);
  });

  it("POST /runs/:id/pin and DELETE /runs/:id/pin", async () => {
    const harness = await boot();
    const post = await harness.call("/runs/run_1/pin", {
      method: "POST",
      actor: "session:sess_1",
    });
    expect(post.status).toBe(403);

    const del = await harness.call("/runs/run_1/pin", {
      method: "DELETE",
      actor: "session:sess_1",
    });
    expect(del.status).toBe(403);
  });

  it("still answers the operator (human) normally, on every verb above", async () => {
    const harness = await boot();
    expect((await harness.call("/maintenance/state")).status).toBe(200);
    expect((await harness.call("/reset/plan?scope=everything")).status).toBe(
      200,
    );
    expect(
      (await harness.call("/maintenance/compact", { method: "POST" })).status,
    ).toBe(200);
  });
});
