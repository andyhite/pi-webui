/**
 * The manifest is a conforming `PluginManifest` on contract v1: checked
 * through the SDK's own boundary functions (`readDescriptor` /
 * `checkConformance`), the same rules `PluginHost` applies when it loads a
 * plugin for real (covered separately in `host.test.ts`, against the real
 * worker_threads host).
 */
import { describe, expect, it } from "bun:test";
import { checkConformance, readDescriptor } from "@plotroom/plugin-sdk";

import manifest from "./index.js";

describe("the filesystem plugin manifest", () => {
  it("reads as a valid descriptor", () => {
    const result = readDescriptor(manifest);
    expect(result.ok).toBe(true);
  });

  it("conforms to contract v1 with no problems", () => {
    const result = readDescriptor(manifest);
    if (!result.ok) throw new Error(result.problems.join("; "));
    const conformance = checkConformance(result.descriptor);
    expect(conformance.problems).toEqual([]);
    expect(conformance.conformant).toBe(true);
  });

  it("declares contractVersion 1 and its own plugin id", () => {
    expect(manifest.contractVersion).toBe(1);
    expect(manifest.id).toBe("filesystem");
  });

  it("declares only the fs-read permission, honestly reasoned", () => {
    expect(manifest.permissions).toHaveLength(1);
    const [permission] = manifest.permissions;
    expect(permission?.kind).toBe("filesystem");
    expect(permission?.reason.length).toBeGreaterThan(0);
  });

  it("contributes no write actions or agent tools (browse/drag is read-only)", () => {
    expect(manifest.contributions.writeActions ?? []).toEqual([]);
    expect(manifest.contributions.agentTools ?? []).toEqual([]);
    expect(manifest.contributions.workspaceKinds ?? []).toEqual([]);
  });
});
