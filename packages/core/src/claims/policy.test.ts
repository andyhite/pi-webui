import { describe, expect, it } from "vitest";

import type { ClaimId, ClaimPolicyId } from "./ids.js";
import { claimPath } from "./paths.js";
import {
  describePolicy,
  evaluatePolicies,
  globMatches,
  MATCH_EVERYTHING,
  policyMatches,
  type ClaimPolicy,
} from "./policy.js";

let counter = 0;

function policy(
  subtree: string,
  effect: ClaimPolicy["effect"],
  overrides: Partial<ClaimPolicy> = {},
): ClaimPolicy {
  counter += 1;
  return {
    id: `claimpol_${counter}` as ClaimPolicyId,
    declaredByClaimId: "claim_root" as ClaimId,
    subtree: claimPath(subtree),
    effect,
    pattern: MATCH_EVERYTHING,
    declaredAt: counter,
    ...overrides,
  };
}

describe("globMatches", () => {
  it("matches everything under a subtree with `**`, including the subtree itself", () => {
    expect(globMatches("**", [])).toBe(true);
    expect(globMatches("**", ["a", "b", "c"])).toBe(true);
  });

  it("keeps `*` inside one segment", () => {
    expect(globMatches("*.ts", ["auth.ts"])).toBe(true);
    expect(globMatches("*.ts", ["nested", "auth.ts"])).toBe(false);
    expect(globMatches("**/*.ts", ["nested", "auth.ts"])).toBe(true);
  });

  it("matches `?` against exactly one character", () => {
    expect(globMatches("a?.ts", ["ab.ts"])).toBe(true);
    expect(globMatches("a?.ts", ["abc.ts"])).toBe(false);
  });

  it("treats regex metacharacters in a pattern as literals", () => {
    expect(globMatches("a+b.ts", ["a+b.ts"])).toBe(true);
    expect(globMatches("a+b.ts", ["aab.ts"])).toBe(false);
  });
});

describe("policyMatches", () => {
  it("only applies inside the declared subtree", () => {
    const allow = policy("src", "allow");
    expect(policyMatches(allow, claimPath("src/auth.ts"))).toBe(true);
    expect(policyMatches(allow, claimPath("src"))).toBe(true);
    expect(policyMatches(allow, claimPath("docs/readme.md"))).toBe(false);
  });

  it("matches the pattern relative to the subtree, case-insensitively", () => {
    const allow = policy("src", "allow", { pattern: "**/*.ts" });
    expect(policyMatches(allow, claimPath("src/api/Auth.TS"))).toBe(true);
    expect(policyMatches(allow, claimPath("src/api/auth.tsx"))).toBe(false);
  });
});

describe("evaluatePolicies", () => {
  it("says nothing when no policy covers the path — approval is the fallback", () => {
    expect(
      evaluatePolicies([policy("docs", "allow")], claimPath("src/a.ts")).kind,
    ).toBe("unstated");
  });

  it("lets a holder pre-grant a subtree (§3.4's twenty-file change)", () => {
    const verdict = evaluatePolicies(
      [policy("src", "allow")],
      claimPath("src/a/b/c.ts"),
    );
    expect(verdict.kind).toBe("allow");
  });

  it("denies where a holder closed a subtree", () => {
    const verdict = evaluatePolicies(
      [policy("src", "allow"), policy("migrations", "deny")],
      claimPath("migrations/0007_add_column.sql"),
    );
    expect(verdict.kind).toBe("deny");
  });

  it("lets deny win over a deeper, more specific allow", () => {
    const verdict = evaluatePolicies(
      [policy(".", "deny"), policy("src/api/handlers", "allow")],
      claimPath("src/api/handlers/auth.ts"),
    );
    expect(verdict.kind).toBe("deny");
  });

  it("lets deny win whatever order the rules arrive in", () => {
    const deny = policy("migrations", "deny");
    const allow = policy("migrations", "allow");
    const path = claimPath("migrations/x.sql");
    expect(evaluatePolicies([deny, allow], path).kind).toBe("deny");
    expect(evaluatePolicies([allow, deny], path).kind).toBe("deny");
  });

  it("reports the deepest matching rule of the winning effect", () => {
    const shallow = policy(".", "allow");
    const deep = policy("src/api", "allow");
    const verdict = evaluatePolicies(
      [shallow, deep],
      claimPath("src/api/auth.ts"),
    );
    expect(verdict.kind === "allow" && verdict.by.id).toBe(deep.id);
  });

  it("prefers a literal rule over a wildcard one at the same depth", () => {
    const wildcard = policy("src", "allow", { pattern: "**" });
    const literal = policy("src", "allow", { pattern: "auth.ts" });
    const verdict = evaluatePolicies(
      [wildcard, literal],
      claimPath("src/auth.ts"),
    );
    expect(verdict.kind === "allow" && verdict.by.id).toBe(literal.id);
  });
});

describe("describePolicy", () => {
  it("reads as something an agent can act on", () => {
    expect(describePolicy(policy("migrations", "deny"))).toBe(
      "deny under migrations",
    );
    expect(describePolicy(policy("src", "allow", { pattern: "**/*.ts" }))).toBe(
      "allow under src matching **/*.ts",
    );
  });
});
