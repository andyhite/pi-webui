import { describe, expect, it } from "vitest";

import { spaceVar } from "./space.js";

describe("spaceVar", () => {
  it("names the custom property for a step", () => {
    expect(spaceVar(6)).toBe("var(--pr-space-6)");
  });

  it("leaves an unset step unset, rather than defaulting one in", () => {
    expect(spaceVar(undefined)).toBeUndefined();
  });
});
