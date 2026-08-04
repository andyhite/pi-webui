import { describe, expect, it } from "vitest";

import { toPickerSummary } from "./backend-picker-window.js";
import type { RemoteBackend } from "./desktop-config.js";

describe("toPickerSummary", () => {
  it("carries id, label, and url", () => {
    const backend: RemoteBackend = {
      id: "a",
      label: "Cloud VM",
      url: "https://plotroom.example.com",
      credential: "secret",
    };
    expect(toPickerSummary(backend)).toEqual({
      id: "a",
      label: "Cloud VM",
      url: "https://plotroom.example.com",
    });
  });

  it("never includes the credential, even when one is remembered", () => {
    const backend: RemoteBackend = {
      id: "a",
      label: "Cloud VM",
      url: "https://plotroom.example.com",
      credential: "super-secret",
    };
    const summary = toPickerSummary(backend);
    expect(Object.keys(summary).sort()).toEqual(["id", "label", "url"]);
    expect(JSON.stringify(summary)).not.toContain("super-secret");
  });

  it("has no credential field to omit when the backend has none remembered", () => {
    const backend: RemoteBackend = {
      id: "b",
      label: "Office desktop",
      url: "https://office.example.com",
      credential: null,
    };
    expect(toPickerSummary(backend)).toEqual({
      id: "b",
      label: "Office desktop",
      url: "https://office.example.com",
    });
  });
});
