import { describe, expect, it } from "bun:test";
import { SessionHostNotReady, SessionHostSilent } from "@plotroom/core";
import { EntityNotFound } from "@plotroom/db";
import { toApiError } from "./domain-errors.js";

/**
 * The one place a domain refusal becomes an HTTP response.
 *
 * What is pinned here is the guarantee the module claims: a refusal is a 4xx
 * carrying its reason, never a 500 and never a message thrown away. An error
 * class this function does not know answers `null`, which `app.ts` renders as
 * `internal_error` — so a class reaching the boundary unmapped is a reason the
 * operator never sees.
 */
describe("toApiError", () => {
  it("reports a runtime that would not start as a refusal, not a 500 (issue #108)", () => {
    const mapped = toApiError(new SessionHostNotReady(180_000));

    expect(mapped).not.toBeNull();
    expect(mapped?.status).toBe(409);
    // The sentence is about a live process the operator can go and look at.
    expect(mapped?.toBody()).toEqual({
      error: {
        code: "refused",
        message:
          "the session host did not report a session within 180s, so PlotRoom stopped waiting and aborted it",
        details: { reason: "runtime_would_not_start" },
      },
    });
  });

  it("reports a runtime that answered nothing the same way", () => {
    const mapped = toApiError(new SessionHostSilent("prompt", 30_000));

    expect(mapped?.status).toBe(409);
    expect(mapped?.message).toContain(
      "did not acknowledge a prompt command within 30s",
    );
  });

  it("still answers null for an error it does not know", () => {
    // The honest default: an unrecognised failure is the server's own, and
    // dressing it up as a refusal would put a 4xx on a bug.
    expect(toApiError(new Error("something else"))).toBeNull();
  });

  it("keeps naming an unknown id a 404", () => {
    expect(toApiError(new EntityNotFound("run", "run_missing"))?.status).toBe(
      404,
    );
  });
});
