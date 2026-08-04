import { INHERIT_APP_TOOLS } from "@plotroom/core";
import type {
  RuntimeCapabilities,
  RuntimeSessionHandle,
  RuntimeStartConfig,
  SessionRuntimeAdapter,
} from "@plotroom/core";
import { describe, expect, it } from "vitest";

import { RuntimeRegistry } from "./registry.js";

/**
 * C6, as a gate rather than a note (decision 0001): a runtime that cannot refuse
 * a tool call on PlotRoom's word may not run work at all.
 *
 * The three verbs that produce a live handle are tested together on purpose. A
 * check on `start` alone was the hole this file exists to close: resume and fork
 * run work too, and a call site that reached the adapter directly ran it ungated.
 */
const CONFIG: RuntimeStartConfig = {
  prompt: "do the thing",
  launch: {
    model: "stand-in",
    effort: "off",
    toolPermissions: INHERIT_APP_TOOLS,
  },
  workspacePath: "/workspaces/one",
};

function adapterWith(
  capabilities: Partial<RuntimeCapabilities>,
): SessionRuntimeAdapter & { readonly calls: string[] } {
  const calls: string[] = [];
  const handle = { ref: "native-1" } as RuntimeSessionHandle;
  return {
    id: "stand-in",
    capabilities: {
      fork: "turn-boundary",
      injection: "between-turns",
      reportsCost: true,
      reportsContextWindow: false,
      enforcesPermissions: true,
      ...capabilities,
    },
    calls,
    start: () => {
      calls.push("start");
      return Promise.resolve(handle);
    },
    resume: () => {
      calls.push("resume");
      return Promise.resolve(handle);
    },
    fork: () => {
      calls.push("fork");
      return Promise.resolve(handle);
    },
  };
}

describe("RuntimeRegistry's permission gate", () => {
  it("runs work on a runtime that enforces PlotRoom's decisions", async () => {
    const adapter = adapterWith({});
    const registry = new RuntimeRegistry();
    registry.register(adapter, { default: true });

    await registry.start(null, { config: CONFIG });
    await registry.resume(null, "native-1", {
      launch: CONFIG.launch,
      workspacePath: CONFIG.workspacePath,
    });
    await registry.fork(null, "native-1", { turn: 1 }, CONFIG);

    expect(adapter.calls).toEqual(["start", "resume", "fork"]);
  });

  it("refuses every verb on a runtime whose permissions are advisory", async () => {
    const adapter = adapterWith({ enforcesPermissions: false });
    const registry = new RuntimeRegistry();
    registry.register(adapter, { default: true });

    await expect(registry.start(null, { config: CONFIG })).rejects.toThrow(
      /permissions/,
    );
    await expect(
      registry.resume(null, "native-1", {
        launch: CONFIG.launch,
        workspacePath: CONFIG.workspacePath,
      }),
    ).rejects.toThrow(/permissions/);
    await expect(
      registry.fork(null, "native-1", { turn: 1 }, CONFIG),
    ).rejects.toThrow(/permissions/);

    // Refused before the adapter was asked: nothing ran, gated or otherwise.
    expect(adapter.calls).toEqual([]);
  });

  it("still reports an ungated runtime's capabilities", () => {
    // `require` deliberately does not gate: a stored session's capabilities are
    // what fork planning reads, and that must keep answering whatever they are.
    const adapter = adapterWith({ enforcesPermissions: false });
    const registry = new RuntimeRegistry();
    registry.register(adapter, { default: true });

    expect(registry.require("stand-in").capabilities.enforcesPermissions).toBe(
      false,
    );
  });
});
