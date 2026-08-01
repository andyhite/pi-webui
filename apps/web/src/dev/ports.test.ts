import { describe, expect, it } from "vitest";

import { DEFAULT_PLOTROOM_PORT, resolveDevPorts } from "./ports.js";

describe("resolveDevPorts", () => {
  it("defaults the dev server to DEFAULT_PLOTROOM_PORT and the proxy target one above it", () => {
    expect(resolveDevPorts({})).toEqual({
      devServer: DEFAULT_PLOTROOM_PORT,
      proxyTarget: DEFAULT_PLOTROOM_PORT + 1,
    });
  });

  it("derives both ports from the one PLOTROOM_PORT setting", () => {
    expect(resolveDevPorts({ PLOTROOM_PORT: "6000" })).toEqual({
      devServer: 6000,
      proxyTarget: 6001,
    });
  });

  it("rejects a non-integer value", () => {
    expect(() => resolveDevPorts({ PLOTROOM_PORT: "nope" })).toThrow();
  });

  it("rejects zero or negative values", () => {
    expect(() => resolveDevPorts({ PLOTROOM_PORT: "0" })).toThrow();
    expect(() => resolveDevPorts({ PLOTROOM_PORT: "-5" })).toThrow();
  });
});
