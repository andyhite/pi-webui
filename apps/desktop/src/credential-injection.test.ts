import { describe, expect, it } from "vitest";

import { buildInjectedHeaders, originMatches } from "./credential-injection.js";

describe("originMatches", () => {
  it("matches identical origins", () => {
    expect(
      originMatches(
        "https://plotroom.example.com/api/health",
        "https://plotroom.example.com",
      ),
    ).toBe(true);
  });

  it("ignores path and query", () => {
    expect(
      originMatches(
        "https://plotroom.example.com/ws?foo=bar",
        "https://plotroom.example.com",
      ),
    ).toBe(true);
  });

  it("matches across http/ws (and https/wss) schemes for the same host:port", () => {
    expect(
      originMatches(
        "ws://plotroom.example.com/ws",
        "http://plotroom.example.com",
      ),
    ).toBe(true);
    expect(
      originMatches(
        "wss://plotroom.example.com/ws",
        "https://plotroom.example.com",
      ),
    ).toBe(true);
  });

  it("does not match a different port", () => {
    expect(
      originMatches(
        "https://plotroom.example.com:8443/api/health",
        "https://plotroom.example.com",
      ),
    ).toBe(false);
  });

  it("does not match a plain http request against a remembered https backend, even though URL#host elides both default ports identically", () => {
    // The regression this guards: `new URL("http://host").host` and
    // `new URL("https://host").host` are both just "host" (default ports
    // 80/443 are never shown) — a host-only comparison would have matched
    // this pair and sent the Bearer credential over a downgraded, cleartext
    // connection.
    expect(
      originMatches(
        "http://plotroom.example.com/api/health",
        "https://plotroom.example.com",
      ),
    ).toBe(false);
    expect(
      originMatches(
        "ws://plotroom.example.com/ws",
        "wss://plotroom.example.com",
      ),
    ).toBe(false);
  });

  it("matches an explicit default port against an implicit one", () => {
    expect(
      originMatches(
        "https://plotroom.example.com:443/api/health",
        "https://plotroom.example.com",
      ),
    ).toBe(true);
    expect(
      originMatches(
        "http://plotroom.example.com:80/api/health",
        "http://plotroom.example.com",
      ),
    ).toBe(true);
  });

  it("does not match across security classes even when the explicit port coincides", () => {
    expect(
      originMatches(
        "http://plotroom.example.com:443/api/health",
        "https://plotroom.example.com",
      ),
    ).toBe(false);
  });

  it("does not match a different host", () => {
    expect(
      originMatches(
        "https://other.example.com/api/health",
        "https://plotroom.example.com",
      ),
    ).toBe(false);
  });

  it("returns false for an unparseable URL rather than throwing", () => {
    expect(originMatches("not a url", "https://plotroom.example.com")).toBe(
      false,
    );
  });
});

describe("buildInjectedHeaders", () => {
  it("adds an Authorization bearer header", () => {
    expect(buildInjectedHeaders({}, "secret")).toEqual({
      Authorization: "Bearer secret",
    });
  });

  it("preserves existing headers", () => {
    expect(buildInjectedHeaders({ "X-Foo": "bar" }, "secret")).toEqual({
      "X-Foo": "bar",
      Authorization: "Bearer secret",
    });
  });
});
