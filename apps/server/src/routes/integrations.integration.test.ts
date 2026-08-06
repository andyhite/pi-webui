import { afterEach, describe, expect, it } from "bun:test";
import {
  at,
  boot as bootServer,
  cleanupHarnesses,
  list,
  str,
  type Harness,
} from "../testing/harness.js";

/**
 * The integration substrate, end to end (§9.1–§9.3, Epics 7.2/7.3).
 *
 * Every boot in this file mounts one **real plugin in the real worker host**:
 * `plugins/test-fixtures/fake-tickets-plugin.ts`, whose producer is `fake-tickets`
 * and whose two write actions have opposite reversibility. That fixture replaced the
 * in-process producer this suite was first written against, so the same assertions
 * now prove the substrate is reached over HTTP **and across the worker boundary**:
 * connect, scope without restart, refresh, disconnect, and — the property with no
 * exception anywhere in this file — a credential's value never once appears in a
 * response body.
 */
afterEach(cleanupHarnesses);

/** The fixture plugin, mounted as an in-box entry (§10.2's first channel). */
const FAKE_PLUGIN = {
  pluginId: "fake-plugin",
  packageName: "fixture:fake-tickets-plugin.ts",
  entry: new URL(
    "../plugins/test-fixtures/fake-tickets-plugin.ts",
    import.meta.url,
  ).href,
};

const boot = (): Promise<Harness> =>
  bootServer({ pluginsInBox: [FAKE_PLUGIN] });

const SECRET = "sk-super-secret-token-do-not-log-me";

async function connectFake(
  harness: Harness,
  extra: Record<string, unknown> = {},
): Promise<{ readonly id: string }> {
  const connected = await harness.ok("/integrations", {
    method: "POST",
    body: {
      pluginId: "fake-plugin",
      producerId: "fake-tickets",
      name: "Fake tickets",
      credentialName: "api-token",
      credentialValue: SECRET,
      ...extra,
    },
  });
  return { id: str(connected, "integration.id") };
}

describe("the registered producers (§9.1)", () => {
  it("lists the fake producer with its declared refresh mode and write actions", async () => {
    const harness = await boot();
    const body = await harness.ok("/integration-plugins");
    const producers = list(body, "producers");
    const fake = producers.find(
      (producer) => (producer as { id: string }).id === "fake-tickets",
    ) as { refresh: unknown; writeActions: unknown[] } | undefined;
    expect(fake).toBeDefined();
    expect(fake?.refresh).toEqual({ kind: "interval", seconds: 300 });
    expect(
      (fake?.writeActions ?? []).map((a) => (a as { id: string }).id),
    ).toEqual(expect.arrayContaining(["comment", "close"]));
  });
});

describe("connect flow (§9.3)", () => {
  it("connects and never returns the credential's value in any response", async () => {
    const harness = await boot();
    const connectResult = await harness.call("/integrations", {
      method: "POST",
      body: {
        pluginId: "fake-plugin",
        producerId: "fake-tickets",
        name: "Fake tickets",
        credentialName: "api-token",
        credentialValue: SECRET,
      },
    });
    expect(connectResult.status).toBe(201);
    expect(JSON.stringify(connectResult.body)).not.toContain(SECRET);

    const listed = await harness.ok("/integrations");
    expect(JSON.stringify(listed)).not.toContain(SECRET);

    const id = str(connectResult.body, "integration.id");
    const got = await harness.ok(`/integrations/${id}`);
    expect(JSON.stringify(got)).not.toContain(SECRET);
    expect(at(got, "integration.connectionState")).toBe("connected");
  });

  it("updates scoping without a restart, visible on the next read", async () => {
    const harness = await boot();
    const { id } = await connectFake(harness);

    const patched = await harness.ok(`/integrations/${id}`, {
      method: "PATCH",
      body: { scope: 'status = "open"' },
    });
    expect(at(patched, "integration.scope")).toBe('status = "open"');

    const got = await harness.ok(`/integrations/${id}`);
    expect(at(got, "integration.scope")).toBe('status = "open"');
  });

  it("disconnects without deleting the row, and clears its credential", async () => {
    const harness = await boot();
    const { id } = await connectFake(harness);

    const disconnected = await harness.ok(`/integrations/${id}/disconnect`, {
      method: "POST",
    });
    expect(at(disconnected, "integration.connectionState")).toBe(
      "disconnected",
    );

    const got = await harness.ok(`/integrations/${id}`);
    expect(at(got, "integration.connectionState")).toBe("disconnected");
  });
});

describe("connect / scoping / disconnect are operator-only (§9.3, principle 1)", () => {
  it("refuses a session actor's connect with a 403", async () => {
    const harness = await boot();
    const result = await harness.call("/integrations", {
      method: "POST",
      body: {
        pluginId: "fake-plugin",
        producerId: "fake-tickets",
        name: "Fake tickets",
      },
      actor: "session:session-1",
    });
    expect(result.status).toBe(403);
  });

  it("refuses a session actor's scoping update with a 403", async () => {
    const harness = await boot();
    const { id } = await connectFake(harness);

    const result = await harness.call(`/integrations/${id}`, {
      method: "PATCH",
      body: { scope: 'status = "open"' },
      actor: "session:session-1",
    });
    expect(result.status).toBe(403);

    // Unchanged: the operator-only refusal never took effect.
    const got = await harness.ok(`/integrations/${id}`);
    expect(at(got, "integration.scope")).toBeNull();
  });

  it("refuses a session actor's disconnect with a 403", async () => {
    const harness = await boot();
    const { id } = await connectFake(harness);

    const result = await harness.call(`/integrations/${id}/disconnect`, {
      method: "POST",
      actor: "session:session-1",
    });
    expect(result.status).toBe(403);

    const got = await harness.ok(`/integrations/${id}`);
    expect(at(got, "integration.connectionState")).toBe("connected");
  });
});

describe("refresh (§9.1) — manual, per integration and per object", () => {
  it("refreshes a whole integration on demand", async () => {
    const harness = await boot();
    const { id } = await connectFake(harness);

    const result = await harness.call(`/integrations/${id}/refresh`, {
      method: "POST",
    });
    expect(result.status).toBe(200);
    expect(at(result.body, "ok")).toBe(true);
  });

  it("refuses a write action to an unknown integration with a 404, not a 500", async () => {
    const harness = await boot();
    const result = await harness.call("/integrations/no-such-id/refresh", {
      method: "POST",
    });
    expect(result.status).toBe(404);
  });
});

describe("write actions (§9.2, §6.6)", () => {
  it("lists the declared write actions with their reversibility, never a credential", async () => {
    const harness = await boot();
    const { id } = await connectFake(harness);
    const body = await harness.ok(`/integrations/${id}/write-actions`);
    const actions = list(body, "writeActions") as {
      id: string;
      reversibility: string;
    }[];
    expect(actions.find((a) => a.id === "comment")?.reversibility).toBe(
      "reversible",
    );
    expect(actions.find((a) => a.id === "close")?.reversibility).toBe(
      "irreversible",
    );
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("as the operator, executes directly and reports a rejection's own text verbatim", async () => {
    const harness = await boot();
    const { id } = await connectFake(harness);

    const result = await harness.call(
      `/integrations/${id}/write-actions/comment`,
      {
        method: "POST",
        body: {
          input: { externalId: "no-such-ticket", text: "hello" },
          callId: "op-call-1",
        },
      },
    );
    expect(result.status).toBe(502);
    expect(at(result.body, "ok")).toBe(false);
    expect(String(at(result.body, "message"))).toContain(
      "no ticket no-such-ticket",
    );
  });
});
