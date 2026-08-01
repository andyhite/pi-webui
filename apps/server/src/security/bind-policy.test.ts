import { describe, expect, it } from "vitest";
import { checkBindPolicy } from "./bind-policy.js";

describe("checkBindPolicy (spec §12)", () => {
  it("allows loopback with no credential configured", () => {
    expect(
      checkBindPolicy({
        host: "127.0.0.1",
        allowNonLoopbackBind: false,
        credential: null,
      }),
    ).toEqual({ ok: true });
  });

  it("refuses non-loopback without the explicit opt-in", () => {
    const result = checkBindPolicy({
      host: "0.0.0.0",
      allowNonLoopbackBind: false,
      credential: "s3cret",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses non-loopback opt-in without a credential", () => {
    const result = checkBindPolicy({
      host: "0.0.0.0",
      allowNonLoopbackBind: true,
      credential: null,
    });
    expect(result.ok).toBe(false);
  });

  it("allows non-loopback only with both the opt-in and a credential", () => {
    expect(
      checkBindPolicy({
        host: "0.0.0.0",
        allowNonLoopbackBind: true,
        credential: "s3cret",
      }),
    ).toEqual({ ok: true });
  });
});
