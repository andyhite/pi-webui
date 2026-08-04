import { describe, expect, it } from "vitest";

import { DEFAULT_PLOTROOM_PORT, resolvePort } from "./config.js";

describe("resolvePort", () => {
  it("defaults to DEFAULT_PLOTROOM_PORT when PLOTROOM_PORT is unset", () => {
    expect(resolvePort({})).toBe(DEFAULT_PLOTROOM_PORT);
  });

  it("uses PLOTROOM_PORT when set", () => {
    expect(resolvePort({ PLOTROOM_PORT: "5555" })).toBe(5555);
  });

  it("defaults to the same port apps/server binds by default", () => {
    // apps/server/src/config.ts's DEFAULT_PORT (duplicated, not imported —
    // see the comment on DEFAULT_PLOTROOM_PORT).
    expect(DEFAULT_PLOTROOM_PORT).toBe(4600);
  });

  it("rejects a non-integer value", () => {
    expect(() => resolvePort({ PLOTROOM_PORT: "abc" })).toThrow();
  });

  it("rejects zero or negative values", () => {
    expect(() => resolvePort({ PLOTROOM_PORT: "0" })).toThrow();
    expect(() => resolvePort({ PLOTROOM_PORT: "-1" })).toThrow();
  });

  it("rejects a value above the last port, agreeing with the server's own bound", () => {
    // `PORT_BOUND` in apps/server/src/config.ts refuses this too. A desktop that
    // accepted a port the server refuses would spawn a backend that dies at boot.
    expect(() => resolvePort({ PLOTROOM_PORT: "65536" })).toThrow();
    expect(resolvePort({ PLOTROOM_PORT: "65535" })).toBe(65_535);
  });
});
