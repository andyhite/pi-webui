import { describe, expect, it } from "bun:test";
import { checkCredential } from "./credential.js";
import { checkOrigin } from "./origin.js";
import { LiveSecurityPolicy } from "./live-policy.js";

/**
 * A settings write (§11, Epic 8.3) mutates this holder's fields in place, and
 * both gates read it fresh on every request — this is the whole mechanism
 * that makes trusted origins and the operator credential apply without a
 * restart, asserted directly rather than only through the settings service
 * that calls it.
 */
describe("LiveSecurityPolicy (§12, Epic 8.3)", () => {
  it("a mutated trustedOrigins list is what the very next check reads", () => {
    const policy = new LiveSecurityPolicy({
      trustedOrigins: [],
      credential: null,
    });

    const before = checkOrigin(
      { origin: "https://plotroom.example.com", host: undefined },
      policy,
    );
    expect(before.allowed).toBe(false);

    policy.trustedOrigins = ["https://plotroom.example.com"];

    const after = checkOrigin(
      { origin: "https://plotroom.example.com", host: undefined },
      policy,
    );
    expect(after.allowed).toBe(true);
  });

  it("a mutated credential is what the very next check reads", () => {
    const policy = new LiveSecurityPolicy({
      trustedOrigins: [],
      credential: null,
    });

    // No credential configured: every request is allowed (§12, local by default).
    expect(
      checkCredential(
        { authorizationHeader: undefined, credentialQueryParam: undefined },
        policy.credential,
      ).allowed,
    ).toBe(true);

    policy.credential = "shh-its-a-secret";

    const denied = checkCredential(
      { authorizationHeader: undefined, credentialQueryParam: undefined },
      policy.credential,
    );
    expect(denied.allowed).toBe(false);

    const allowed = checkCredential(
      {
        authorizationHeader: "Bearer shh-its-a-secret",
        credentialQueryParam: undefined,
      },
      policy.credential,
    );
    expect(allowed.allowed).toBe(true);
  });
});
