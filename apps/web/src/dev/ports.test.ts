import { describe, expect, it } from "vitest";

import { DEFAULT_PLOTROOM_PORT, resolveDevPorts } from "./ports.js";

describe("resolveDevPorts", () => {
  it("defaults the proxy target to DEFAULT_PLOTROOM_PORT and Vite's own port one above it", () => {
    expect(resolveDevPorts({})).toEqual({
      proxyTarget: DEFAULT_PLOTROOM_PORT,
      devServer: DEFAULT_PLOTROOM_PORT + 1,
    });
  });

  it("matches apps/server's own default port (4600) when unset", () => {
    expect(DEFAULT_PLOTROOM_PORT).toBe(4600);
  });

  it("derives both ports from the one PLOTROOM_PORT setting", () => {
    expect(resolveDevPorts({ PLOTROOM_PORT: "6000" })).toEqual({
      proxyTarget: 6000,
      devServer: 6001,
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
