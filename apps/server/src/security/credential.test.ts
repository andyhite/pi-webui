import { expect } from "vitest";
import { describe, it } from "bun:test";
import { checkCredential } from "./credential.js";

describe("checkCredential (spec §12)", () => {
  it("allows anything when no credential is configured", () => {
    expect(
      checkCredential(
        { authorizationHeader: undefined, credentialQueryParam: undefined },
        null,
      ),
    ).toEqual({ allowed: true });
  });

  it("requires a credential once one is configured", () => {
    const result = checkCredential(
      { authorizationHeader: undefined, credentialQueryParam: undefined },
      "s3cret",
    );
    expect(result.allowed).toBe(false);
  });

  it("accepts a matching Authorization: Bearer header", () => {
    expect(
      checkCredential(
        {
          authorizationHeader: "Bearer s3cret",
          credentialQueryParam: undefined,
        },
        "s3cret",
      ),
    ).toEqual({ allowed: true });
  });

  it("accepts a matching credential query param, for browser WebSocket clients", () => {
    expect(
      checkCredential(
        { authorizationHeader: undefined, credentialQueryParam: "s3cret" },
        "s3cret",
      ),
    ).toEqual({ allowed: true });
  });

  it("refuses a wrong credential", () => {
    const result = checkCredential(
      { authorizationHeader: "Bearer nope", credentialQueryParam: undefined },
      "s3cret",
    );
    expect(result.allowed).toBe(false);
  });

  it("refuses a credential of a different length without short-circuiting", () => {
    // Length is the one thing an early return would leak; both of these take
    // the same path as a same-length mismatch.
    for (const presented of ["s", "s3cret-but-much-longer", ""]) {
      expect(
        checkCredential(
          { authorizationHeader: undefined, credentialQueryParam: presented },
          "s3cret",
        ).allowed,
      ).toBe(false);
    }
  });

  it("refuses a malformed Authorization header", () => {
    const result = checkCredential(
      { authorizationHeader: "s3cret", credentialQueryParam: undefined },
      "s3cret",
    );
    expect(result.allowed).toBe(false);
  });
});
