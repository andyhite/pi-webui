import { describe, expect, it } from "vitest";

import { createUnavailableLifecycleActions } from "./lifecycle-actions.js";

describe("createUnavailableLifecycleActions", () => {
  it("enable refuses honestly rather than silently succeeding", async () => {
    const actions = createUnavailableLifecycleActions();
    const result = await actions.enable("filesystem");
    expect(result).toEqual({
      ok: false,
      refusal: expect.objectContaining({ reason: "not-implemented" }),
    });
  });

  it("disable refuses honestly", async () => {
    const actions = createUnavailableLifecycleActions();
    const result = await actions.disable("filesystem");
    expect(result.ok).toBe(false);
  });

  it("remove refuses honestly", async () => {
    const actions = createUnavailableLifecycleActions();
    const result = await actions.remove("filesystem");
    expect(result.ok).toBe(false);
  });
});
