import { describe, expect, it } from "vitest";
import { checkOrigin, isLoopbackHostname } from "./origin.js";

describe("isLoopbackHostname (spec §12)", () => {
  it("trusts localhost, 127.0.0.1, and ::1", () => {
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("LOCALHOST")).toBe(true);
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("trusts the whole 127.0.0.0/8 range", () => {
    expect(isLoopbackHostname("127.0.0.53")).toBe(true);
    expect(isLoopbackHostname("127.255.255.255")).toBe(true);
  });

  it("does not trust a LAN or public address", () => {
    expect(isLoopbackHostname("192.168.1.10")).toBe(false);
    expect(isLoopbackHostname("0.0.0.0")).toBe(false);
    expect(isLoopbackHostname("evil.example.com")).toBe(false);
  });
});

describe("checkOrigin (spec §12): loopback always trusted, with any port", () => {
  const policy = { trustedOrigins: ["https://plotroom.example.com"] };

  it("allows a loopback Origin at any port — the ssh -L tunnel case", () => {
    expect(
      checkOrigin({ origin: "http://localhost:4600", host: undefined }, policy),
    ).toEqual({ allowed: true });
    expect(
      checkOrigin({ origin: "http://127.0.0.1:9999", host: undefined }, policy),
    ).toEqual({ allowed: true });
  });

  it("refuses a non-loopback Origin not on the allow-list — drive-by/rebinding", () => {
    const result = checkOrigin(
      { origin: "https://evil.example.com", host: undefined },
      policy,
    );
    expect(result.allowed).toBe(false);
  });

  it("allows an exact allow-listed non-loopback origin", () => {
    expect(
      checkOrigin(
        { origin: "https://plotroom.example.com", host: undefined },
        policy,
      ),
    ).toEqual({ allowed: true });
  });

  it("does not allow-list by hostname alone: a different port/scheme still refuses", () => {
    const result = checkOrigin(
      { origin: "http://plotroom.example.com", host: undefined },
      policy,
    );
    expect(result.allowed).toBe(false);
  });

  it("falls back to Host when Origin is absent (non-browser clients)", () => {
    expect(
      checkOrigin({ origin: undefined, host: "localhost:4600" }, policy),
    ).toEqual({ allowed: true });
    const result = checkOrigin(
      { origin: undefined, host: "evil.example.com" },
      policy,
    );
    expect(result.allowed).toBe(false);
  });

  it("refuses when neither Origin nor Host is present", () => {
    const result = checkOrigin({ origin: undefined, host: undefined }, policy);
    expect(result.allowed).toBe(false);
  });

  it("refuses an unparseable Origin rather than treating it as trusted", () => {
    const result = checkOrigin(
      { origin: "not a url at all", host: undefined },
      policy,
    );
    expect(result.allowed).toBe(false);
  });
});
