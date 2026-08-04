import { describe, expect, it } from "vitest";

import {
  EMPTY_DESKTOP_CONFIG,
  activeBackend,
  parseDesktopConfig,
  removeBackend,
  serializeDesktopConfig,
  setActiveBackend,
  setAutoInstallUpdates,
  upsertBackend,
} from "./desktop-config.js";
import type { RemoteBackend } from "./desktop-config.js";

const backendA: RemoteBackend = {
  id: "a",
  label: "Cloud VM",
  url: "https://plotroom.example.com",
  credential: "secret-a",
};
const backendB: RemoteBackend = {
  id: "b",
  label: "Office desktop",
  url: "https://office.example.com",
  credential: null,
};

describe("parseDesktopConfig", () => {
  it("returns the empty config for a missing file", () => {
    expect(parseDesktopConfig(null)).toEqual(EMPTY_DESKTOP_CONFIG);
  });

  it("returns the empty config for corrupt JSON, rather than throwing", () => {
    expect(parseDesktopConfig("{not json")).toEqual(EMPTY_DESKTOP_CONFIG);
  });

  it("round-trips through serializeDesktopConfig", () => {
    const config = upsertBackend(EMPTY_DESKTOP_CONFIG, backendA);
    expect(parseDesktopConfig(serializeDesktopConfig(config))).toEqual(config);
  });

  it("drops an activeBackendId that names no remembered backend", () => {
    const raw = JSON.stringify({
      backends: [backendA],
      activeBackendId: "does-not-exist",
    });
    expect(parseDesktopConfig(raw).activeBackendId).toBeNull();
  });

  it("filters out malformed entries in backends", () => {
    const raw = JSON.stringify({ backends: [backendA, { bogus: true }] });
    expect(parseDesktopConfig(raw).backends).toEqual([backendA]);
  });
});

describe("upsertBackend", () => {
  it("adds a new backend", () => {
    const config = upsertBackend(EMPTY_DESKTOP_CONFIG, backendA);
    expect(config.backends).toEqual([backendA]);
  });

  it("replaces an existing backend with the same id, never duplicating", () => {
    const config = upsertBackend(
      upsertBackend(EMPTY_DESKTOP_CONFIG, backendA),
      { ...backendA, label: "Renamed" },
    );
    expect(config.backends).toHaveLength(1);
    expect(config.backends[0]?.label).toBe("Renamed");
  });
});

describe("removeBackend", () => {
  it("removes the named backend", () => {
    const config = removeBackend(
      upsertBackend(EMPTY_DESKTOP_CONFIG, backendA),
      "a",
    );
    expect(config.backends).toEqual([]);
  });

  it("falls back to local when removing the active backend", () => {
    const withActive = setActiveBackend(
      upsertBackend(EMPTY_DESKTOP_CONFIG, backendA),
      "a",
    );
    const config = removeBackend(withActive, "a");
    expect(config.activeBackendId).toBeNull();
  });

  it("leaves the active id alone when removing a different backend", () => {
    const withBoth = upsertBackend(
      upsertBackend(EMPTY_DESKTOP_CONFIG, backendA),
      backendB,
    );
    const withActive = setActiveBackend(withBoth, "a");
    const config = removeBackend(withActive, "b");
    expect(config.activeBackendId).toBe("a");
  });
});

describe("setActiveBackend", () => {
  it("switches to a remembered backend", () => {
    const config = setActiveBackend(
      upsertBackend(EMPTY_DESKTOP_CONFIG, backendA),
      "a",
    );
    expect(activeBackend(config)).toEqual(backendA);
  });

  it("switches back to local with null", () => {
    const withActive = setActiveBackend(
      upsertBackend(EMPTY_DESKTOP_CONFIG, backendA),
      "a",
    );
    const config = setActiveBackend(withActive, null);
    expect(activeBackend(config)).toBeNull();
  });

  it("refuses to switch to an unknown id", () => {
    expect(() => setActiveBackend(EMPTY_DESKTOP_CONFIG, "nope")).toThrow();
  });
});

describe("setAutoInstallUpdates", () => {
  it("defaults to false", () => {
    expect(EMPTY_DESKTOP_CONFIG.autoInstallUpdates).toBe(false);
  });

  it("is an explicit, isolated toggle", () => {
    const config = setAutoInstallUpdates(EMPTY_DESKTOP_CONFIG, true);
    expect(config.autoInstallUpdates).toBe(true);
    expect(config.backends).toEqual([]);
  });
});
