import { describe, expect, it } from "vitest";

import { DEFAULT_PLOTROOM_PORT, resolvePort } from "./config.js";

describe("resolvePort", () => {
  it("defaults to DEFAULT_PLOTROOM_PORT when PLOTROOM_PORT is unset", () => {
    expect(resolvePort({})).toBe(DEFAULT_PLOTROOM_PORT);
  });

  it("uses PLOTROOM_PORT when set", () => {
    expect(resolvePort({ PLOTROOM_PORT: "5555" })).toBe(5555);
  });

  it("rejects a non-integer value", () => {
    expect(() => resolvePort({ PLOTROOM_PORT: "abc" })).toThrow();
  });

  it("rejects zero or negative values", () => {
    expect(() => resolvePort({ PLOTROOM_PORT: "0" })).toThrow();
    expect(() => resolvePort({ PLOTROOM_PORT: "-1" })).toThrow();
  });
});
