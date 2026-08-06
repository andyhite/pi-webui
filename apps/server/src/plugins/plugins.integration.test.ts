import { expect } from "vitest";
import type { DomainEvent } from "@plotroom/core";
import { afterEach, describe, it } from "bun:test";
import {
  at,
  boot,
  cleanupHarnesses,
  list,
  str,
  waitFor,
  type Harness,
} from "../testing/harness.js";
import { IN_BOX_PLUGINS, type InBoxPluginEntry } from "./in-box.js";

/**
 * The plugin platform, mounted and running for real (§10.2, Epics 7.1/7.2/7.3).
 *
 * Every plugin in this file is loaded by the **real `worker_threads` host** through
 * `PluginRegistry`, from a real module on disk, over the frozen contract v1. Nothing
 * is stubbed: the producers answering these HTTP calls are running in their own
 * threads, and the health this surface reports is what those threads actually did.
 *
 * The first `describe` is **Batch 5's exit criterion**, named so a failure reads as
 * the gate failing rather than as an unrelated plugin test: "a throwing plugin
 * degrades to 'unavailable,' never a product that won't start".
 */
afterEach(cleanupHarnesses);

const SECRET = "sk-fixture-token-do-not-log-me";

const fixture = (file: string, pluginId: string): InBoxPluginEntry => ({
  pluginId,
  packageName: `fixture:${file}`,
  entry: new URL(`./test-fixtures/${file}`, import.meta.url).href,
});

const HEALTHY = fixture("fake-tickets-plugin.ts", "fake-plugin");
const THROWS = fixture("throws-on-read-plugin.ts", "throws-on-read");
const CRASHES = fixture("crashes-on-read-plugin.ts", "crashes-on-read");
const NO_MANIFEST = fixture("not-a-plugin.ts", "not-a-plugin");
const NEEDS_CREDENTIAL = fixture(
  "needs-credential-plugin.ts",
  "needs-credential",
);

const withPlugins = (...plugins: InBoxPluginEntry[]) =>
  boot({ pluginsInBox: plugins });

const pluginRow = async (
  harness: Harness,
  pluginId: string,
): Promise<Record<string, unknown>> => {
  const body = await harness.ok("/plugins");
  const row = list(body, "plugins").find(
    (candidate) => (candidate as { pluginId: string }).pluginId === pluginId,
  );
  if (row === undefined) {
    throw new Error(`no plugin row for ${pluginId} in ${JSON.stringify(body)}`);
  }
  return row as Record<string, unknown>;
};

const connect = async (
  harness: Harness,
  input: {
    readonly pluginId: string;
    readonly producerId: string;
    readonly scope?: string | null;
    readonly credentialName?: string;
    readonly credentialValue?: string;
  },
): Promise<string> => {
  const connected = await harness.ok("/integrations", {
    method: "POST",
    body: { name: `${input.producerId} instance`, ...input },
  });
  return str(connected, "integration.id");
};

describe("THE BATCH 5 GATE: a throwing plugin degrades to 'unavailable' while the server and every other plugin keep answering (§10.2)", () => {
  it("GATE: reports the reason on /api/plugins, keeps serving, and the other plugin still answers", async () => {
    const harness = await withPlugins(HEALTHY, THROWS);

    // Both loaded in their own worker and both are ready before anything breaks.
    expect(at(await pluginRow(harness, "fake-plugin"), "health")).toBe("ready");
    expect(at(await pluginRow(harness, "throws-on-read"), "health")).toBe(
      "ready",
    );

    const healthy = await connect(harness, {
      pluginId: "fake-plugin",
      producerId: "fake-tickets",
    });
    const broken = await connect(harness, {
      pluginId: "throws-on-read",
      producerId: "throwing-tickets",
    });

    // The fault: a producer read that throws rather than returning `ok: false`.
    const refresh = await harness.call(`/integrations/${broken}/refresh`, {
      method: "POST",
    });
    expect(refresh.status).toBe(502);

    // 1. That plugin, and only that plugin, is unavailable — with the reason.
    const brokenRow = await pluginRow(harness, "throws-on-read");
    expect(at(brokenRow, "health")).toBe("unavailable");
    expect(String(at(brokenRow, "reason"))).toContain(
      "this producer is deliberately broken",
    );

    // 2. The server is still serving.
    const health = await harness.call("/health");
    expect(health.status).toBe(200);

    // 3. The other plugin keeps answering — over its own worker, unaffected.
    const stillHealthy = await harness.call(
      `/integrations/${healthy}/refresh`,
      {
        method: "POST",
      },
    );
    expect(stillHealthy.status).toBe(200);
    expect(at(stillHealthy.body, "ok")).toBe(true);
    expect(at(await pluginRow(harness, "fake-plugin"), "health")).toBe("ready");

    // 4. And the objects the broken integration had already produced are not
    //    touched: a broken connection is a health problem, never missing data.
    const brokenIntegration = await harness.ok(`/integrations/${broken}`);
    expect(at(brokenIntegration, "integration.connectionState")).toBe("broken");
  });

  it("GATE: a plugin that crashes its worker never takes the server or its neighbour with it", async () => {
    const harness = await withPlugins(HEALTHY, CRASHES);

    const crashing = await connect(harness, {
      pluginId: "crashes-on-read",
      producerId: "crashing-tickets",
    });
    const healthy = await connect(harness, {
      pluginId: "fake-plugin",
      producerId: "fake-tickets",
    });

    const refresh = await harness.call(`/integrations/${crashing}/refresh`, {
      method: "POST",
    });
    expect(refresh.status).toBe(502);

    // Restarts are bounded (principle 11): the row is honest about which of the
    // two states it is in, and it is never "ready" while the worker is gone.
    const state = await waitFor(async () => {
      const row = await pluginRow(harness, "crashes-on-read");
      const health = at(row, "health");
      return health === "restarting" || health === "unavailable"
        ? health
        : null;
    }, "the crashed plugin to report restarting or unavailable");
    expect(["restarting", "unavailable"]).toContain(state);

    expect((await harness.call("/health")).status).toBe(200);
    const stillHealthy = await harness.call(
      `/integrations/${healthy}/refresh`,
      {
        method: "POST",
      },
    );
    expect(stillHealthy.status).toBe(200);
  });

  it("GATE: a module with no manifest is an install failure with a reason, not a boot failure", async () => {
    const harness = await withPlugins(HEALTHY, NO_MANIFEST);

    const body = await harness.ok("/plugins");
    const failures = list(body, "failures");
    expect(failures).toHaveLength(1);
    expect(String(at(failures[0], "reason"))).not.toBe("");
    // Nothing pretends the plugin exists: there is no row for it at all, because
    // there is no manifest to state an id, a name, or a version from.
    expect(
      list(body, "plugins").map(
        (row) => (row as { pluginId: string }).pluginId,
      ),
    ).toEqual(["fake-plugin"]);
    expect((await harness.call("/health")).status).toBe(200);
  });
});

describe("THE BATCH 5 GATE: all four in-box plugins run on the public contract (§10.2, §9.4)", () => {
  it("GATE: loads git, GitHub, Filesystem and Jira in their own workers and reports each ready", async () => {
    // The real list, resolved the way a packaged build resolves it — so this test
    // fails if a plugin package stops shipping a loadable entry point.
    const harness = await boot({ pluginsInBox: IN_BOX_PLUGINS });

    const body = await harness.ok("/plugins");
    expect(list(body, "failures")).toEqual([]);
    const rows = list(body, "plugins") as Record<string, unknown>[];
    // Four ids the *manifests* declared, never the four lines in the in-box list:
    // a mistyped package name is an install failure, not a renamed plugin.
    expect(rows.map((row) => row["pluginId"]).sort()).toEqual([
      "coding-git",
      "filesystem",
      "github",
      "jira",
    ]);
    for (const row of rows) {
      expect(row["health"], String(row["pluginId"])).toBe("ready");
      expect(row["state"]).toBe("enabled");
      expect(row["origin"]).toBe("in-box");
      expect(row["contractVersion"], String(row["pluginId"])).toBe(1);
    }

    // Their concept producers are in the substrate, each showing the plugin's own
    // scoping declaration verbatim (§9.1, Epic 7.3's ask of this track).
    const producers = list(
      await harness.ok("/integration-plugins"),
      "producers",
    ) as { id: string; scoping: { language: string; example: string } }[];
    const documents = producers.find((one) => one.id === "fs-documents");
    expect(documents).toBeDefined();
    expect(documents?.scoping.language).not.toBe("");
    expect(producers.map((one) => one.id)).toEqual(
      expect.arrayContaining([
        "pull-requests",
        "workspace-diff",
        "workspace-commits",
        // Jira's three, including the epic producer whose collection membership is
        // stated by external id because the contract has nowhere else to put it.
        "jira-issues",
        "jira-epics-as-collections",
        "jira-workflow",
      ]),
    );

    // Jira's own declaration reached the surface intact: its credential permission
    // is unanswered (§10.2's `never-asked`, the state that raises through §6.6) and
    // its scope language is Jira's own — JQL, not a paraphrase (§9.1).
    const jira = rows.find((row) => row["pluginId"] === "jira");
    const permissions = jira?.["permissions"] as Record<string, unknown>[];
    expect(permissions.length).toBeGreaterThan(0);
    for (const permission of permissions) {
      expect(at(permission, "state"), String(at(permission, "id"))).toBe(
        "never-asked",
      );
    }
    const issues = producers.find((one) => one.id === "jira-issues");
    expect(issues?.scoping.language.toLowerCase()).toContain("jql");
  });
});

describe("the health surface (§10.2)", () => {
  it("reports state, health, declared permissions with the operator's answer, and contributions", async () => {
    const harness = await withPlugins(NEEDS_CREDENTIAL);
    const row = await pluginRow(harness, "needs-credential");

    expect(at(row, "state")).toBe("enabled");
    expect(at(row, "health")).toBe("ready");
    expect(at(row, "origin")).toBe("in-box");
    expect(at(row, "contractVersion")).toBe(1);
    expect(at(row, "reason")).toBeNull();
    expect(at(row, "warnings")).toEqual([]);

    const permissions = row["permissions"] as Record<string, unknown>[];
    expect(permissions).toHaveLength(1);
    expect(at(permissions[0], "id")).toBe("fake-token");
    expect(at(permissions[0], "state")).toBe("never-asked");
    // The plugin's own sentence, verbatim, and a scope description that names the
    // credential by id and system — never a value (§9.3).
    expect(at(permissions[0], "reason")).toBe("to read the fake source at all");
    expect(String(at(permissions[0], "scope"))).toContain("fake-system");

    expect(row["contributions"]).toEqual([
      { point: "concept-producer", id: "credentialed-tickets" },
    ]);
  });

  it("shows the connection state of an integration connected to one of its producers", async () => {
    const harness = await withPlugins(HEALTHY);
    await connect(harness, {
      pluginId: "fake-plugin",
      producerId: "fake-tickets",
    });

    const row = await pluginRow(harness, "fake-plugin");
    const integrations = row["integrations"] as Record<string, unknown>[];
    expect(integrations).toHaveLength(1);
    expect(at(integrations[0], "connectionState")).toBe("connected");
    expect(at(integrations[0], "producerId")).toBe("fake-tickets");
  });
});

describe("declared permissions, granted by the operator (§10.2, §9.3)", () => {
  it("refuses an ungranted reach, names what to grant, and never invents a value", async () => {
    const harness = await withPlugins(NEEDS_CREDENTIAL);
    const id = await connect(harness, {
      pluginId: "needs-credential",
      producerId: "credentialed-tickets",
      credentialName: "fake-token",
      credentialValue: SECRET,
    });

    const refused = await harness.call(`/integrations/${id}/refresh`, {
      method: "POST",
    });
    // Nobody has answered, and there is no session to ask against: the reach is
    // refused, naming the operator's own grant route (§6.6's raise needs a session).
    expect(refused.status).toBe(403);
    expect(at(refused.body, "error.code")).toBe("plugin_permission_ungranted");
    expect(String(at(refused.body, "error.message"))).toContain("fake-token");
    expect(JSON.stringify(refused.body)).not.toContain(SECRET);

    // An ungranted permission is not a broken connection (§9.3 vs §10.2).
    const integration = await harness.ok(`/integrations/${id}`);
    expect(at(integration, "integration.connectionState")).toBe("connected");
  });

  it("grants without a restart, injects the stored value for that one call, and redacts it out of the result", async () => {
    const harness = await withPlugins(NEEDS_CREDENTIAL);
    const id = await connect(harness, {
      pluginId: "needs-credential",
      producerId: "credentialed-tickets",
      credentialName: "fake-token",
      credentialValue: SECRET,
    });

    const granted = await harness.ok("/plugins/needs-credential/grants", {
      method: "POST",
      body: { permissionId: "fake-token", state: "granted" },
    });
    expect(at(granted, "plugin.permissions.0.state")).toBe("granted");

    const refresh = await harness.call(`/integrations/${id}/refresh`, {
      method: "POST",
    });
    expect(refresh.status).toBe(200);
    expect(at(refresh.body, "ok")).toBe(true);

    // The fixture echoes its token deliberately; the host replaced it with a
    // marker before it left the boundary, so the response cannot carry it (§9.3).
    const serialized = JSON.stringify(refresh.body);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain("[redacted:fake-token]");
  });

  it("a denial refuses the call and raises nothing, because it was answered", async () => {
    const harness = await withPlugins(NEEDS_CREDENTIAL);
    const id = await connect(harness, {
      pluginId: "needs-credential",
      producerId: "credentialed-tickets",
      credentialName: "fake-token",
      credentialValue: SECRET,
    });

    await harness.ok("/plugins/needs-credential/grants", {
      method: "POST",
      body: { permissionId: "fake-token", state: "denied" },
    });

    const refused = await harness.call(`/integrations/${id}/refresh`, {
      method: "POST",
    });
    expect(refused.status).toBe(409);
    expect(at(refused.body, "error.code")).toBe("plugin_call_refused");
  });

  it("removing a grant makes the permission never-asked again", async () => {
    const harness = await withPlugins(NEEDS_CREDENTIAL);
    await harness.ok("/plugins/needs-credential/grants", {
      method: "POST",
      body: { permissionId: "fake-token", state: "granted" },
    });
    const removed = await harness.ok("/plugins/needs-credential/grants", {
      method: "POST",
      body: { permissionId: "fake-token", state: null },
    });
    expect(at(removed, "plugin.permissions.0.state")).toBe("never-asked");
  });

  it("refuses a grant for a permission the plugin never declared", async () => {
    const harness = await withPlugins(NEEDS_CREDENTIAL);
    const result = await harness.call("/plugins/needs-credential/grants", {
      method: "POST",
      body: { permissionId: "invented-permission", state: "granted" },
    });
    expect(result.status).toBe(404);
  });
});

describe("install / enable / disable / remove, without a restart (§10.2)", () => {
  it("disabling makes the producer unreachable and enabling brings it back", async () => {
    const harness = await withPlugins(HEALTHY);
    const id = await connect(harness, {
      pluginId: "fake-plugin",
      producerId: "fake-tickets",
    });
    expect(
      (await harness.call(`/integrations/${id}/refresh`, { method: "POST" }))
        .status,
    ).toBe(200);

    const disabled = await harness.ok("/plugins/fake-plugin/disable", {
      method: "POST",
    });
    expect(at(disabled, "plugin.state")).toBe("disabled");
    expect(at(disabled, "plugin.health")).toBe("disabled");

    // The integration keeps its row and its objects (§3.1); what it loses is the
    // ability to refresh, and that is reported rather than silently degraded.
    const afterDisable = await harness.call(`/integrations/${id}/refresh`, {
      method: "POST",
    });
    expect(afterDisable.status).toBe(404);
    expect(
      at(
        await harness.ok(`/integrations/${id}`),
        "integration.connectionState",
      ),
    ).toBe("connected");

    const enabled = await harness.ok("/plugins/fake-plugin/enable", {
      method: "POST",
    });
    expect(at(enabled, "plugin.state")).toBe("enabled");
    expect(
      (await harness.call(`/integrations/${id}/refresh`, { method: "POST" }))
        .status,
    ).toBe(200);
  });

  it("removing forgets the plugin and its answered permissions, and deletes nothing on disk", async () => {
    const harness = await withPlugins(NEEDS_CREDENTIAL);
    await harness.ok("/plugins/needs-credential/grants", {
      method: "POST",
      body: { permissionId: "fake-token", state: "granted" },
    });

    const removed = await harness.ok("/plugins/needs-credential", {
      method: "DELETE",
    });
    expect(at(removed, "removed")).toBe(true);
    expect(list(await harness.ok("/plugins"), "plugins")).toEqual([]);

    // The module is still on disk: installing it again is a plugin the operator
    // never lost, and its permission is unanswered because the row went with it.
    const installed = await harness.ok("/plugins/install", {
      method: "POST",
      body: { entry: NEEDS_CREDENTIAL.entry },
    });
    expect(at(installed, "plugin.state")).toBe("installed");
    expect(at(installed, "plugin.permissions.0.state")).toBe("never-asked");
  });

  it("answers an unreadable install with a reason and a 200, never a 500", async () => {
    const harness = await withPlugins();
    const result = await harness.call("/plugins/install", {
      method: "POST",
      body: { entry: NO_MANIFEST.entry },
    });
    expect(result.status).toBe(200);
    expect(at(result.body, "installed")).toBe(false);
    expect(String(at(result.body, "failure.reason"))).not.toBe("");
  });
});

describe("every plugin verb is the operator's (§10.2, principle 1)", () => {
  it("refuses a session actor's install, enable, disable, remove, and grant with a 403", async () => {
    const harness = await withPlugins(HEALTHY);
    const asSession = { actor: "session:session-1" } as const;

    for (const call of [
      { path: "/plugins/install", method: "POST", body: { entry: "anything" } },
      { path: "/plugins/fake-plugin/enable", method: "POST" },
      { path: "/plugins/fake-plugin/disable", method: "POST" },
      { path: "/plugins/fake-plugin", method: "DELETE" },
      {
        path: "/plugins/fake-plugin/grants",
        method: "POST",
        body: { permissionId: "fake-token", state: "granted" },
      },
    ]) {
      const result = await harness.call(call.path, {
        method: call.method,
        ...(call.body === undefined ? {} : { body: call.body }),
        ...asSession,
      });
      expect(result.status, `${call.method} ${call.path}`).toBe(403);
    }

    // Nothing took effect: the plugin is still enabled and still answering.
    expect(at(await pluginRow(harness, "fake-plugin"), "state")).toBe(
      "enabled",
    );
  });

  it("the read surface is not operator-only: a session may see what plugins exist", async () => {
    const harness = await withPlugins(HEALTHY);
    const result = await harness.call("/plugins", {
      actor: "session:session-1",
    });
    expect(result.status).toBe(200);
  });
});

describe("plugin lifecycle on the one event stream (§10.2)", () => {
  it("publishes a plugin event a health panel can subscribe to", async () => {
    const harness = await withPlugins(HEALTHY);
    const events: DomainEvent[] = [];
    const socket = new WebSocket(`ws://127.0.0.1:${harness.port}/ws`, {
      headers: { origin: `http://localhost:${harness.port}` },
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("error", reject);
      socket.addEventListener("message", (event) => {
        const message = JSON.parse(String(event.data)) as {
          type: string;
          event?: DomainEvent;
        };
        if (message.type === "hello") resolve();
        if (message.type === "event" && message.event)
          events.push(message.event);
      });
    });

    await harness.ok("/plugins/fake-plugin/disable", { method: "POST" });

    const published = await waitFor(
      async () =>
        events.find(
          (event) =>
            (event as { entity?: string }).entity === "plugin" &&
            at(event, "status.state") === "disabled",
        ) ?? null,
      "a plugin event on the stream",
    );
    expect(at(published, "status.pluginId")).toBe("fake-plugin");
    expect(at(published, "status.health")).toBe("disabled");
    socket.close();
  });
});
