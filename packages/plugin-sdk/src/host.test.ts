import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CoreId } from "./contract/ids.js";
import type { PermissionGrant } from "./contract/permissions.js";
import {
  PluginCallRefusedError,
  PluginHost,
  PluginUnavailableError,
  type PluginHostOptions,
} from "./host.js";

const fixture = (name: string): URL =>
  new URL(`./test-fixtures/${name}`, import.meta.url);

const hosts: PluginHost[] = [];

const load = async (
  name: string,
  options?: PluginHostOptions,
): Promise<PluginHost> => {
  const host = await PluginHost.load(fixture(name), options);
  hosts.push(host);
  return host;
};

const coreId = (value: string): CoreId => value as unknown as CoreId;

const actor = {
  sessionId: coreId("sess_1"),
  workstreamId: coreId("ws_1"),
};

const granted = (...ids: string[]): PermissionGrant[] =>
  ids.map((permissionId) => ({
    pluginId: "test-plugin",
    permissionId,
    state: "granted" as const,
    answeredAt: 1,
  }));

const reasonOf = (host: PluginHost): string =>
  host.health.status === "unavailable" ? host.health.reason : "";

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
});

describe("a conformant plugin", () => {
  it("loads, reports its twelve contribution points, and disposes", async () => {
    const host = await load("test-plugin/index.ts");

    expect(host.health.status).toBe("ready");
    const descriptor = host.descriptor;
    expect(descriptor?.id).toBe("test-plugin");
    const points = new Set(descriptor?.contributions.map((c) => c.point));
    expect(points).toEqual(
      new Set([
        "concept-producer",
        "write-action",
        "agent-tool",
        "content-renderer",
        "card-renderer",
        "panel",
        "palette-entry",
        "workspace-kind",
        "condition-check",
        "notification-route",
        "command-definition",
        "theme",
      ]),
    );
    // Declarations cross the boundary; handlers do not.
    const tool = descriptor?.contributions.find((c) => c.id === "fixture_echo");
    expect(typeof tool?.declaration["call"]).toBe("undefined");
    expect(tool?.declaration["summary"]).toBe("echo the input back");

    await host.dispose();
    expect(host.health).toEqual({ status: "disposed" });
  });

  it("dispose is idempotent", async () => {
    const host = await load("test-plugin/index.ts");

    await host.dispose();
    await host.dispose();
    expect(host.health).toEqual({ status: "disposed" });
  });

  it("dispatches every invocation kind over the typed RPC", async () => {
    const host = await load("test-plugin/index.ts", {
      grants: granted("api", "token"),
      credentials: () => "fixture-secret-value",
    });

    const read = await host.invoke({
      kind: "concept.read",
      contributionId: "tickets",
      request: { scope: "project = FIX", externalId: null },
    });
    expect(read.objects[0]?.externalId).toBe("FIX-1");
    expect(read.unavailable).toEqual([]);

    const write = await host.invoke({
      kind: "write.perform",
      contributionId: "transition",
      input: { externalId: "FIX-1" },
    });
    expect(write.ok).toBe(true);
    expect(write.readBack).toBeNull();

    const tool = await host.invoke(
      {
        kind: "tool.call",
        contributionId: "fixture_echo",
        input: { text: "hi" },
      },
      { actor },
    );
    expect(tool).toEqual({ ok: true, content: '{"text":"hi"}' });

    const condition = await host.invoke({
      kind: "condition.check",
      contributionId: "fixture-met",
      input: {},
    });
    expect(condition.state).toBe("met");

    const object = read.objects[0];
    if (object === undefined) {
      throw new Error("the producer returned nothing");
    }
    const content = await host.invoke({
      kind: "content.render",
      contributionId: "ticket-content",
      object,
    });
    expect(content.content).toContain("scope=project = FIX");

    const delta = await host.invoke({
      kind: "content.delta",
      contributionId: "ticket-content",
      previous: object,
      next: { ...object, title: "renamed" },
    });
    // Truncation is a fact the renderer reports, never a silent cap (principle 12).
    expect(delta.truncated).toEqual({ omittedBytes: 12, why: "fixture cap" });

    const card = await host.invoke({
      kind: "card.render",
      contributionId: "ticket-card",
      object,
      detail: "expanded",
    });
    expect(card.lines).toEqual(["a fixture ticket"]);
    expect(card.actions[0]?.writeActionId).toBe("transition");
  });

  it("routes a plugin's log lines to the host without a channel back", async () => {
    const lines: string[] = [];
    const host = await load("test-plugin/index.ts", {
      onLog: (line) => lines.push(line.message),
    });

    await host.invoke(
      { kind: "tool.call", contributionId: "fixture_echo", input: {} },
      { actor },
    );
    expect(lines).toEqual(["echoing"]);
  });

  it("refuses an invocation naming a contribution the plugin does not have", async () => {
    const host = await load("test-plugin/index.ts");

    await expect(
      host.invoke({
        kind: "condition.check",
        contributionId: "not-a-check",
        input: {},
      }),
    ).rejects.toBeInstanceOf(PluginCallRefusedError);
    // A host mistake is not a plugin fault: the plugin stays ready.
    expect(host.health.status).toBe("ready");
  });
});

describe("failure isolation (§10.2): load", () => {
  it("a missing module degrades to unavailable with a reported reason", async () => {
    const host = await load("does-not-exist.ts");

    expect(host.health.status).toBe("unavailable");
    expect(reasonOf(host)).toMatch(/does-not-exist/);
    await expect(
      host.invoke({ kind: "condition.check", contributionId: "x", input: {} }),
    ).rejects.toBeInstanceOf(PluginUnavailableError);
  });

  it("a plugin that throws while loading degrades to unavailable", async () => {
    const host = await load("throws-on-load-plugin.ts");

    expect(host.health).toEqual({
      status: "unavailable",
      reason: "exploded while loading",
    });
  });

  it("a plugin that hangs while loading times out to unavailable", async () => {
    const host = await load("hangs-on-load-plugin.ts", { loadTimeoutMs: 250 });

    expect(host.health.status).toBe("unavailable");
    expect(reasonOf(host)).toMatch(/did not load within 250ms/);
  });

  it("a module that is not a manifest degrades to unavailable", async () => {
    const host = await load("not-a-plugin.ts");

    expect(host.health.status).toBe("unavailable");
    expect(reasonOf(host)).toMatch(/not a plugin manifest/);
  });

  it("a nonconformant manifest degrades to unavailable, listing the problems", async () => {
    const host = await load("nonconformant-plugin.ts");

    expect(host.health.status).toBe("unavailable");
    expect(reasonOf(host)).toMatch(/producing but names no expected outcome/);
  });
});

describe("contract versioning (§10.2)", () => {
  it("refuses a plugin built against a newer contract, naming both versions", async () => {
    const host = await load("future-contract-plugin.ts");

    expect(host.health.status).toBe("unavailable");
    expect(reasonOf(host)).toMatch(/v99/);
    expect(reasonOf(host)).toMatch(/implements v1/);
  });

  it("warns rather than refuses for an older supported contract", async () => {
    const host = await load("test-plugin/index.ts", {
      contractRange: { host: 2, minimum: 1 },
    });

    expect(host.health.status).toBe("ready");
    if (host.health.status === "ready") {
      expect(host.health.warnings[0]).toMatch(/out of date, not broken/);
    }
  });
});

describe("failure isolation (§10.2): calls", () => {
  it("a plugin that throws on a call rejects it and degrades to unavailable", async () => {
    const host = await load("throws-on-call-plugin.ts");

    await expect(
      host.invoke(
        { kind: "tool.call", contributionId: "boom", input: {} },
        { actor },
      ),
    ).rejects.toBeInstanceOf(PluginUnavailableError);
    expect(host.health).toEqual({
      status: "unavailable",
      reason: "plugin threw: boom on call",
    });
  });

  it("a plugin that hangs on a call times out and degrades to unavailable", async () => {
    const host = await load("hangs-on-call-plugin.ts", { callTimeoutMs: 250 });

    await expect(
      host.invoke(
        { kind: "tool.call", contributionId: "hang", input: {} },
        { actor },
      ),
    ).rejects.toBeInstanceOf(PluginUnavailableError);
    expect(reasonOf(host)).toMatch(/did not answer within 250ms/);
  });

  it("calling an unavailable plugin rejects instead of crashing", async () => {
    const host = await load("throws-on-load-plugin.ts");

    await expect(
      host.invoke({ kind: "condition.check", contributionId: "x", input: {} }),
    ).rejects.toThrow(/plugin unavailable: exploded while loading/);
  });
});

describe("isolation between plugins", () => {
  it("one failing plugin does not affect a healthy one", async () => {
    const [broken, healthy] = await Promise.all([
      load("throws-on-load-plugin.ts"),
      load("test-plugin/index.ts"),
    ]);

    expect(broken?.health.status).toBe("unavailable");
    const result = await healthy?.invoke(
      {
        kind: "tool.call",
        contributionId: "fixture_echo",
        input: { text: "still-here" },
      },
      { actor },
    );
    expect(result?.content).toBe('{"text":"still-here"}');
  });
});

describe("bounded restarts (principle 11)", () => {
  const counterFile = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "plotroom-plugin-"));
    const file = join(dir, "attempts");
    await writeFile(file, "");
    process.env["PLOTROOM_TEST_CRASH_COUNTER"] = file;
    return file;
  };

  it("restarts a plugin that crashed after loading, then serves the next call", async () => {
    await counterFile();
    const host = await load("crashing-plugin.ts", {
      restart: { maxRestarts: 2, backoffMs: [10] },
    });

    await expect(
      host.invoke(
        { kind: "tool.call", contributionId: "maybe_crash", input: {} },
        { actor },
      ),
    ).rejects.toBeInstanceOf(PluginUnavailableError);

    const health = await host.settled();
    expect(health.status).toBe("ready");
    const result = await host.invoke(
      { kind: "tool.call", contributionId: "maybe_crash", input: {} },
      { actor },
    );
    expect(result.content).toBe("attempt 2");
  });

  it("gives up after the bounded number of restarts, saying so", async () => {
    await counterFile();
    const host = await load("crashing-plugin.ts", {
      restart: { maxRestarts: 0, backoffMs: [10] },
    });

    await expect(
      host.invoke(
        { kind: "tool.call", contributionId: "maybe_crash", input: {} },
        { actor },
      ),
    ).rejects.toBeInstanceOf(PluginUnavailableError);
    const health = await host.settled();
    expect(health.status).toBe("unavailable");
    expect(reasonOf(host)).toMatch(/gave up after 0 restarts/);
  });
});
