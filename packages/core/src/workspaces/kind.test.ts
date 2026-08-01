import { describe, expect, it } from "vitest";

import { newWorkspaceId } from "./ids.js";
import {
  WorkspaceKindRegistry,
  type ProvisionOutcome,
  type WorkspaceKind,
  type WorkspaceStatus,
} from "./kind.js";

const NOW = 1_700_000_000_000;

function stubKind(name: string): WorkspaceKind {
  const workspaceId = newWorkspaceId();
  const status: WorkspaceStatus = {
    workspaceId,
    kind: name,
    observedAt: NOW,
    units: [],
    unavailable: null,
  };
  const provisioned: ProvisionOutcome = {
    provisioned: true,
    roots: [],
    cost: {
      elapsedMillis: 0,
      bytesOnDisk: null,
      sharedCache: "unavailable",
      strategy: "none",
    },
    log: [],
    notes: [],
  };
  return {
    name,
    checkConfig: () => ({ valid: true }),
    provision: () => Promise.resolve(provisioned),
    runSetup: () => {
      throw new Error("not used");
    },
    status: () => Promise.resolve(status),
    fingerprint: () =>
      Promise.resolve({ kind: name, observedAt: NOW, units: [] }),
    probeAncestry: () => Promise.resolve(new Map()),
    remove: () => Promise.resolve({ removed: true, log: [] }),
  };
}

describe("WorkspaceKindRegistry", () => {
  it("refuses an unknown kind with a reason rather than throwing (§10.2)", () => {
    const registry = new WorkspaceKindRegistry();

    expect(registry.get("git")).toBeNull();
    expect(registry.require("git")).toMatchObject({
      available: false,
      refusal: { reason: "unknown_kind" },
    });
  });

  it("hands back a registered kind", () => {
    const registry = new WorkspaceKindRegistry();
    const kind = stubKind("git");

    registry.register(kind);

    expect(registry.names()).toEqual(["git"]);
    expect(registry.require("git")).toEqual({ available: true, kind });
  });

  it("reports a kind as unavailable once its plugin goes away (§10.2)", () => {
    const registry = new WorkspaceKindRegistry();
    registry.register(stubKind("jj"));

    registry.unregister("jj");

    expect(registry.require("jj").available).toBe(false);
  });

  it("accepts a kind with no discovery — not every mechanism has anything to scan for", () => {
    const registry = new WorkspaceKindRegistry();
    const docsOnly = stubKind("docs");

    registry.register(docsOnly);

    expect(docsOnly.discover).toBeUndefined();
    expect(registry.require("docs").available).toBe(true);
  });
});
