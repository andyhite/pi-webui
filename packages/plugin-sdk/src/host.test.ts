import { afterEach, describe, expect, it } from "vitest";
import { PluginHost, PluginUnavailableError } from "./host.js";

const fixture = (name: string): URL =>
  new URL(`./test-fixtures/${name}`, import.meta.url);

const hosts: PluginHost[] = [];

const load = async (
  name: string,
  options?: Parameters<typeof PluginHost.load>[1],
): Promise<PluginHost> => {
  const host = await PluginHost.load(fixture(name), options);
  hosts.push(host);
  return host;
};

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
});

describe("a healthy plugin", () => {
  it("loads, answers a ping over the channel, and disposes", async () => {
    const host = await load("healthy-plugin.ts");

    expect(host.health).toEqual({ status: "ready", name: "healthy" });
    expect(await host.ping("hello")).toBe("pong:hello");

    await host.dispose();
    expect(host.health).toEqual({ status: "disposed" });
  });

  it("dispose is idempotent", async () => {
    const host = await load("healthy-plugin.ts");

    await host.dispose();
    await host.dispose();
    expect(host.health).toEqual({ status: "disposed" });
  });
});

describe("failure isolation (§10.2): load", () => {
  it("a missing module degrades to unavailable with a reported reason", async () => {
    const host = await load("does-not-exist.ts");

    expect(host.health.status).toBe("unavailable");
    if (host.health.status === "unavailable") {
      expect(host.health.reason).toMatch(/does-not-exist/);
    }
    await expect(host.ping("x")).rejects.toBeInstanceOf(PluginUnavailableError);
  });

  it("a plugin that throws while loading degrades to unavailable", async () => {
    const host = await load("throws-on-load-plugin.ts");

    expect(host.health).toEqual({
      status: "unavailable",
      reason: "exploded while loading",
    });
  });

  it("a plugin that hangs while loading times out to unavailable", async () => {
    const host = await load("hangs-on-load-plugin.ts", {
      loadTimeoutMs: 250,
    });

    expect(host.health.status).toBe("unavailable");
    if (host.health.status === "unavailable") {
      expect(host.health.reason).toMatch(/did not load within 250ms/);
    }
  });

  it("a module that is not a plugin degrades to unavailable", async () => {
    const host = await load("not-a-plugin.ts");

    expect(host.health.status).toBe("unavailable");
    if (host.health.status === "unavailable") {
      expect(host.health.reason).toMatch(/plugin contract/);
    }
  });
});

describe("failure isolation (§10.2): calls", () => {
  it("a plugin that throws on a call rejects it and degrades to unavailable", async () => {
    const host = await load("throws-on-ping-plugin.ts");

    await expect(host.ping("x")).rejects.toBeInstanceOf(PluginUnavailableError);
    expect(host.health).toEqual({
      status: "unavailable",
      reason: "plugin threw: boom on ping",
    });
  });

  it("a plugin that hangs on a call times out and degrades to unavailable", async () => {
    const host = await load("hangs-on-ping-plugin.ts", {
      callTimeoutMs: 250,
    });

    await expect(host.ping("x")).rejects.toBeInstanceOf(PluginUnavailableError);
    expect(host.health.status).toBe("unavailable");
    if (host.health.status === "unavailable") {
      expect(host.health.reason).toMatch(/did not answer within 250ms/);
    }
  });

  it("pinging an unavailable plugin rejects instead of crashing", async () => {
    const host = await load("throws-on-load-plugin.ts");

    await expect(host.ping("x")).rejects.toThrow(
      /plugin unavailable: exploded while loading/,
    );
  });
});

describe("isolation between plugins", () => {
  it("one failing plugin does not affect a healthy one", async () => {
    const [broken, healthy] = await Promise.all([
      load("throws-on-load-plugin.ts"),
      load("healthy-plugin.ts"),
    ]);

    expect(broken.health.status).toBe("unavailable");
    expect(await healthy.ping("still-here")).toBe("pong:still-here");
  });
});
