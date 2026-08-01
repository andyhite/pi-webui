/**
 * The two rules the host enforces that the contract can only declare: **declared
 * permissions, granted by the operator** (§10.2) with credentials exposed to
 * nothing (§9.3), and **a plugin's tool acts as the calling session**
 * (principle 1).
 */
import { afterEach, describe, expect, it } from "vitest";

import type { CoreId } from "./contract/ids.js";
import { HOST_INJECTED_CAPABILITIES } from "./contract/permissions.js";
import type { PermissionGrant } from "./contract/permissions.js";
import {
  PluginCallRefusedError,
  PluginHost,
  type PluginHostOptions,
} from "./host.js";

const TOKEN = "fixture-secret-value";

const fixture = new URL(
  "./test-fixtures/test-plugin/index.ts",
  import.meta.url,
);

const hosts: PluginHost[] = [];

const load = async (options: PluginHostOptions = {}): Promise<PluginHost> => {
  const host = await PluginHost.load(fixture, options);
  hosts.push(host);
  return host;
};

const coreId = (value: string): CoreId => value as unknown as CoreId;

const actor = {
  sessionId: coreId("sess_1"),
  workstreamId: coreId("ws_1"),
};

const grant = (
  permissionId: string,
  state: PermissionGrant["state"],
): PermissionGrant => ({
  pluginId: "test-plugin",
  permissionId,
  state,
  answeredAt: state === "never-asked" ? null : 1,
});

const refusal = async (
  promise: Promise<unknown>,
): Promise<PluginCallRefusedError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PluginCallRefusedError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the call to be refused");
};

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
});

describe("declared permissions (§10.2)", () => {
  it("raises through the approvals channel when nobody has answered", async () => {
    const host = await load();

    const error = await refusal(
      host.invoke(
        { kind: "tool.call", contributionId: "fixture_notify", input: {} },
        { actor },
      ),
    );

    expect(error.reason).toMatch(/no grant for never-granted \(never-asked\)/);
    // §6.6's own vocabulary, so the server maps it onto an ApprovalAsk directly.
    expect(error.raise).toMatchObject({
      pluginId: "test-plugin",
      permissionId: "never-granted",
      kind: "tool-permission",
      trigger: "outside-policy",
      tool: "fixture_notify",
      writeExtent: "none",
      world: null,
      target: null,
    });
    expect(error.raise?.summary).toContain(
      "prove an ungranted permission refuses",
    );
    // The plugin is not at fault and stays available.
    expect(host.health.status).toBe("ready");
  });

  it("refuses without re-raising once the operator has denied it", async () => {
    const host = await load({ grants: [grant("never-granted", "denied")] });

    const error = await refusal(
      host.invoke(
        { kind: "tool.call", contributionId: "fixture_notify", input: {} },
        { actor },
      ),
    );

    expect(error.reason).toMatch(/\(denied\)/);
    expect(error.raise).toBeNull();
  });

  it("takes a grant answered after load into account on the next call", async () => {
    const host = await load();

    await refusal(
      host.invoke({
        kind: "concept.read",
        contributionId: "tickets",
        request: { scope: null, externalId: null },
      }),
    );
    host.setGrants([grant("api", "granted")]);

    const read = await host.invoke({
      kind: "concept.read",
      contributionId: "tickets",
      request: { scope: null, externalId: null },
    });
    expect(read.objects).toHaveLength(1);
  });
});

describe("credentials (§9.3)", () => {
  it("injects a granted credential per call and redacts it out of the result", async () => {
    const asked: string[] = [];
    const host = await load({
      grants: [grant("token", "granted")],
      credentials: ({ credentialId }) => {
        asked.push(credentialId);
        return TOKEN;
      },
    });

    const result = await host.invoke(
      { kind: "tool.call", contributionId: "fixture_leak", input: {} },
      { actor },
    );

    expect(asked).toEqual(["fixture-token"]);
    // The plugin echoed its token; the session gets a marker, never the value.
    expect(result.content).toBe("token=[redacted:fixture-token]");
    expect(result.content).not.toContain(TOKEN);
  });

  it("injects nothing into a call that did not declare the credential", async () => {
    const host = await load({
      grants: [grant("token", "granted")],
      credentials: () => TOKEN,
    });

    const result = await host.invoke(
      {
        kind: "tool.call",
        contributionId: "fixture_echo",
        input: { text: "x" },
      },
      { actor },
    );

    expect(result.content).toBe('{"text":"x"}');
  });

  it("refuses the call when the credential is granted but not stored", async () => {
    const host = await load({
      grants: [grant("token", "granted")],
      credentials: () => null,
    });

    const error = await refusal(
      host.invoke(
        { kind: "tool.call", contributionId: "fixture_leak", input: {} },
        { actor },
      ),
    );

    // A broken connection is an integration health problem, never missing data.
    expect(error.reason).toMatch(/no stored credential for example/);
  });
});

describe("plugins cannot author intent (principle 1)", () => {
  it("a tool call carries the calling session's actor, supplied by the host", async () => {
    const host = await load();

    const result = await host.invoke(
      { kind: "tool.call", contributionId: "fixture_whoami", input: {} },
      { actor },
    );

    expect(JSON.parse(result.content)).toEqual({
      sessionId: "sess_1",
      workstreamId: "ws_1",
    });
  });

  it("refuses a tool call that names no calling session", async () => {
    const host = await load();

    const error = await refusal(
      host.invoke({
        kind: "tool.call",
        contributionId: "fixture_whoami",
        input: {},
      }),
    );

    expect(error.reason).toMatch(/acts as the session that called it/);
  });

  it("acts as nobody for an invocation that is not a tool call", async () => {
    const host = await load({ grants: [grant("api", "granted")] });

    const result = await host.invoke(
      { kind: "condition.check", contributionId: "fixture-met", input: {} },
      // Supplied and deliberately ignored: only a tool call has an actor.
      { actor },
    );

    expect(result.evidence).toBe("actor=null");
  });

  it("injects exactly the enumerated capabilities and nothing else", async () => {
    const host = await load();

    const result = await host.invoke(
      { kind: "tool.call", contributionId: "fixture_context_keys", input: {} },
      { actor },
    );

    // The complete reach a plugin has: two host-injected capabilities plus the
    // two facts about the call itself. Nothing that writes, and nothing that
    // draws a context edge.
    expect(result.content.split(",")).toEqual([
      "actor",
      "credentials",
      "grants",
      "invocationId",
      "log",
    ]);
    for (const capability of HOST_INJECTED_CAPABILITIES) {
      expect(result.content.split(",")).toContain(capability);
    }
  });
});
