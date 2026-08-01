/**
 * The contract's own rules, tested where they are stated: the version verdict, the
 * conformance rules, and the two things the contract must **not** be able to
 * express (an actor a plugin chooses, a capability that authors an edge).
 */
import { describe, expect, it } from "vitest";

import { redactCredentials } from "../credentials.js";
import {
  CONTRACT_VERSION,
  CONTRIBUTION_KEY_BY_POINT,
  CONTRIBUTION_POINTS,
  checkConformance,
  readDescriptor,
  type PluginDescriptor,
} from "./manifest.js";
import {
  CORE_CAPABILITIES,
  HOST_INJECTED_CAPABILITIES,
  describePermission,
  permissionRaise,
} from "./permissions.js";
import { checkContractVersion } from "./versioning.js";

const descriptor = (
  overrides: Partial<PluginDescriptor> = {},
): PluginDescriptor => ({
  id: "p",
  name: "P",
  version: "1.0.0",
  contractVersion: CONTRACT_VERSION,
  permissions: [],
  contributions: [],
  ...overrides,
});

describe("the frozen surface", () => {
  it("is contract v1 and names all twelve §10.1 contribution points", () => {
    expect(CONTRACT_VERSION).toBe(1);
    expect(CONTRIBUTION_POINTS).toHaveLength(12);
    for (const point of CONTRIBUTION_POINTS) {
      expect(CONTRIBUTION_KEY_BY_POINT[point]).toBeTypeOf("string");
    }
  });

  it("has no capability that authors a context edge (principle 1)", () => {
    for (const capability of [
      ...CORE_CAPABILITIES,
      ...HOST_INJECTED_CAPABILITIES,
    ]) {
      expect(capability).not.toMatch(/edge|wire|connect|author/i);
    }
  });
});

describe("contract versioning (§10.2)", () => {
  const range = { host: 2, minimum: 1 };

  it("accepts the version it implements", () => {
    expect(checkContractVersion(2, range).verdict).toBe("ok");
  });

  it("warns for an older supported version rather than refusing", () => {
    const check = checkContractVersion(1, range);
    expect(check.verdict).toBe("warn");
    expect(check.reason).toMatch(/v1/);
    expect(check.reason).toMatch(/v2/);
  });

  it("refuses a newer version, naming both numbers", () => {
    const check = checkContractVersion(3, range);
    expect(check.verdict).toBe("refuse");
    expect(check.reason).toMatch(/built against plugin contract v3/);
    expect(check.reason).toMatch(/implements v2/);
  });

  it("refuses a version older than the host still supports", () => {
    const check = checkContractVersion(1, { host: 3, minimum: 2 });
    expect(check.verdict).toBe("refuse");
    expect(check.reason).toMatch(/supports v2 and newer/);
  });

  it("refuses a version that is not a positive integer", () => {
    expect(checkContractVersion(0).verdict).toBe("refuse");
    expect(checkContractVersion(1.5).verdict).toBe("refuse");
  });
});

describe("reading a manifest at the boundary", () => {
  it("lists every problem rather than throwing on the first", () => {
    const read = readDescriptor({ id: "", contractVersion: "one" });
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.problems).toContain("id must be a non-empty string");
      expect(read.problems).toContain("contractVersion must be an integer");
    }
  });

  it("addresses an agent tool by its name and everything else by its id", () => {
    const read = readDescriptor({
      id: "p",
      name: "P",
      version: "1.0.0",
      contractVersion: 1,
      permissions: [],
      contributions: {
        agentTools: [{ name: "t", requires: { permissions: ["a"] } }],
        themes: [{ id: "th" }],
      },
    });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.descriptor.contributions).toEqual([
        {
          point: "agent-tool",
          id: "t",
          permissions: ["a"],
          declaration: { name: "t", requires: { permissions: ["a"] } },
        },
        {
          point: "theme",
          id: "th",
          permissions: [],
          declaration: { id: "th" },
        },
      ]);
    }
  });
});

describe("conformance (§10.2)", () => {
  it("accepts a manifest that declares nothing", () => {
    expect(checkConformance(descriptor()).conformant).toBe(true);
  });

  it("refuses a write action with no reversibility declaration (§9.2)", () => {
    const result = checkConformance(
      descriptor({
        contributions: [
          {
            point: "write-action",
            id: "merge",
            permissions: [],
            declaration: { id: "merge", action: "merge" },
          },
        ],
      }),
    );
    expect(result.problems).toContain(
      "write action merge declares no reversibility (§9.2)",
    );
  });

  it("refuses a producing command definition with no expected outcome (§3.5)", () => {
    const result = checkConformance(
      descriptor({
        contributions: [
          {
            point: "command-definition",
            id: "c",
            permissions: [],
            declaration: { lifecycle: "producing", expectedOutcome: null },
          },
        ],
      }),
    );
    expect(result.conformant).toBe(false);
    expect(result.problems[0]).toMatch(/names no expected outcome/);
  });

  it("refuses an open command definition that carries one (§3.5)", () => {
    const result = checkConformance(
      descriptor({
        contributions: [
          {
            point: "command-definition",
            id: "c",
            permissions: [],
            declaration: { lifecycle: "open", expectedOutcome: "something" },
          },
        ],
      }),
    );
    expect(result.problems[0]).toMatch(/open but carries an expected outcome/);
  });

  it("refuses a contribution reaching for a permission the manifest never declared", () => {
    const result = checkConformance(
      descriptor({
        contributions: [
          {
            point: "agent-tool",
            id: "t",
            permissions: ["secret"],
            declaration: {},
          },
        ],
      }),
    );
    expect(result.problems[0]).toMatch(/undeclared permission secret/);
  });

  it("refuses a permission with no reason and one whose scope is a different kind", () => {
    const result = checkConformance(
      descriptor({
        permissions: [
          {
            id: "a",
            kind: "network",
            scope: { kind: "network", hosts: ["*"] },
            reason: "  ",
            requiredToLoad: false,
          },
          {
            id: "b",
            kind: "network",
            scope: {
              kind: "credential",
              credentialId: "t",
              system: "example",
            },
            reason: "why",
            requiredToLoad: false,
          },
        ],
      }),
    );
    expect(result.problems).toEqual([
      "permission a states no reason",
      "permission b is a network request with a credential scope",
    ]);
  });

  it("refuses two contributions at one point sharing an id", () => {
    const one = {
      point: "theme" as const,
      id: "t",
      permissions: [],
      declaration: {},
    };
    const result = checkConformance(
      descriptor({ contributions: [one, { ...one }] }),
    );
    expect(result.problems[0]).toMatch(/share the id t/);
  });
});

describe("permissions vocabulary", () => {
  it("describes a blanket network request as blanket", () => {
    expect(
      describePermission({
        id: "a",
        kind: "network",
        scope: { kind: "network", hosts: ["*"] },
        reason: "r",
        requiredToLoad: false,
      }),
    ).toBe("network access to any host");
  });

  it("raises a filesystem request with its roots as the ask's paths", () => {
    const raise = permissionRaise({
      pluginId: "p",
      request: {
        id: "files",
        kind: "filesystem",
        scope: { kind: "filesystem", roots: ["/srv"], access: "read-write" },
        reason: "read the tree",
        requiredToLoad: false,
      },
      tool: "read_tree",
    });
    expect(raise.writeExtent).toBe("paths");
    expect(raise.paths).toEqual(["/srv"]);
    expect(raise.summary).toContain("read the tree");
  });
});

describe("credential redaction (§9.3)", () => {
  it("replaces an injected value wherever it appears", () => {
    const result = redactCredentials(
      { ok: true, content: "Bearer s3cret-value", notes: ["s3cret-value"] },
      [{ credentialId: "tok", value: "s3cret-value" }],
    );
    expect(result).toEqual({
      ok: true,
      content: "Bearer [redacted:tok]",
      notes: ["[redacted:tok]"],
    });
  });

  it("leaves a value too short to be a credential alone", () => {
    expect(redactCredentials("aaa", [{ credentialId: "t", value: "a" }])).toBe(
      "aaa",
    );
  });
});
