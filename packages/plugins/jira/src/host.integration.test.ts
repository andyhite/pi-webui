import {
  PluginCallRefusedError,
  PluginHost,
  PluginRegistry,
  type CoreId,
  type PermissionGrant,
  type PluginActor,
} from "@plotroom/plugin-sdk";
import { afterEach, describe, expect, it } from "bun:test";

import {
  FIXTURE_BUG,
  FIXTURE_CREDENTIAL,
  FIXTURE_EPIC,
  FIXTURE_SITE,
  FIXTURE_TICKET,
  FIXTURE_TOKEN,
} from "./testing/jira-fixture.js";

/**
 * The Jira plugin **in the real worker_threads host**, with a recorded Jira behind it:
 * the manifest, the conformance check, the permission gate, the credential injection
 * and every dispatch are the product's, and the only thing that is not real is Jira. No
 * test here can reach the network.
 *
 * The shipped entry (`src/index.ts`, `fetch`-backed, #315: no build) is loaded too, so what the product
 * would install is proved to conform and load — it is simply never invoked, because
 * invoking it would be the live call this file exists to avoid.
 */

const stubEntry = new URL("../src/testing/stub-entry.ts", import.meta.url);
const shippedEntry = new URL("../src/index.ts", import.meta.url);

const coreId = (value: string): CoreId => value as unknown as CoreId;

const actor: PluginActor = {
  sessionId: coreId("sess_1"),
  workstreamId: coreId("wst_1"),
};

const grants = (...permissionIds: string[]): PermissionGrant[] =>
  permissionIds.map((permissionId) => ({
    pluginId: "jira",
    permissionId,
    state: "granted" as const,
    answeredAt: 1,
  }));

const allGrants = grants("jira-api", "jira-credential");

const hosts: PluginHost[] = [];
const registries: PluginRegistry[] = [];

const load = async (
  options: {
    readonly granted?: PermissionGrant[];
    readonly credential?: string | null;
    readonly entry?: URL;
  } = {},
): Promise<PluginHost> => {
  const host = await PluginHost.load(options.entry ?? stubEntry, {
    grants: options.granted ?? allGrants,
    credentials: () =>
      options.credential === undefined
        ? FIXTURE_CREDENTIAL
        : options.credential,
    callTimeoutMs: 15_000,
  });
  hosts.push(host);
  return host;
};

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
  await Promise.all(
    registries.splice(0).map((registry) => registry.disposeAll()),
  );
});

const scope = (jql: string): string => `site=${FIXTURE_SITE} ${jql}`;

describe("the Jira plugin in the worker host (§9.4, §10.2)", () => {
  it("conforms, loads, and declares what §9.4 asks of it", async () => {
    const host = await load();

    expect(host.health.status).toBe("ready");
    const descriptor = host.descriptor;
    expect(descriptor?.id).toBe("jira");
    expect(descriptor?.contractVersion).toBe(1);
    const points = new Set(descriptor?.contributions.map((one) => one.point));
    expect(points).toEqual(
      new Set([
        "concept-producer",
        "write-action",
        "agent-tool",
        "content-renderer",
        "card-renderer",
        "condition-check",
        "palette-entry",
        "command-definition",
      ]),
    );
    // Every write action's reversibility crossed the boundary as a declaration the
    // host can gate on: conformance refuses one that declared none.
    const writes = (descriptor?.contributions ?? []).filter(
      (one) => one.point === "write-action",
    );
    expect(
      writes.map((one) => one.declaration["reversibility"]).sort(),
    ).toEqual([
      "reversible",
      "reversible",
      "reversible",
      "reversible",
      "unknown",
    ]);
    // The scoping language reaches the host as Jira's own (§9.1).
    const producers = (descriptor?.contributions ?? []).filter(
      (one) => one.point === "concept-producer",
    );
    for (const producer of producers) {
      expect(
        (producer.declaration["scoping"] as { language: string }).language,
      ).toBe("jql");
    }
    // The network scope names Jira Cloud's own domain, not the internet.
    expect(
      descriptor?.permissions.find((one) => one.id === "jira-api")?.scope,
    ).toEqual({ kind: "network", hosts: ["*.atlassian.net"] });
  });

  it("the shipped, fetch-backed entry conforms and loads too", async () => {
    const host = await load({ entry: shippedEntry });
    expect(host.health.status).toBe("ready");
    expect(host.descriptor?.id).toBe("jira");
  });

  it("installs, enables and disables through the registry without a restart (§10.2)", async () => {
    const events: string[] = [];
    const registry = new PluginRegistry({
      grantsFor: () => allGrants,
      host: { credentials: () => FIXTURE_CREDENTIAL, callTimeoutMs: 15_000 },
      onEvent: (event) =>
        events.push(`${event.state}:${event.health?.status ?? "none"}`),
    });
    registries.push(registry);

    const installed = await registry.install(stubEntry, "in-box");
    expect(installed.installed).toBe(true);
    await registry.enable("jira");
    expect(registry.host("jira")?.health.status).toBe("ready");
    await registry.disable("jira");
    expect(registry.get("jira")?.state).toBe("disabled");
    expect(events[0]).toBe("installed:none");
  });

  it("serves an invocation for every dispatchable contribution it declares", async () => {
    const host = await load();

    const tickets = await host.invoke({
      kind: "concept.read",
      contributionId: "jira-issues",
      request: { scope: scope("project = OXY"), externalId: null },
    });
    const ticket = tickets.objects.find(
      (one) =>
        one.externalId === `jira:ticket:${FIXTURE_SITE}/${FIXTURE_TICKET}`,
    );
    if (ticket === undefined) {
      throw new Error("the issue producer returned no OXY-2");
    }
    // A successful read proves the host injected the credential: the recorded Jira
    // answers 401 to a request without it.
    expect(tickets.unavailable).toEqual([]);

    const epics = await host.invoke({
      kind: "concept.read",
      contributionId: "jira-epics-as-collections",
      request: {
        scope: scope("issuetype = Epic AND project = OXY"),
        externalId: null,
      },
    });
    const collection = epics.objects.find((one) => one.kind === "collection");
    if (collection === undefined) {
      throw new Error("the epic producer returned no collection");
    }
    expect(collection.externalId).toBe(
      `jira:collection:${FIXTURE_SITE}/${FIXTURE_EPIC}`,
    );
    // The members came back as tickets in the same read, so expanding the collection
    // is a gesture over objects that already exist (§3.1).
    expect(
      epics.objects
        .filter((one) => one.kind === "ticket")
        .map((one) => one.externalId),
    ).toEqual([
      `jira:ticket:${FIXTURE_SITE}/${FIXTURE_TICKET}`,
      `jira:ticket:${FIXTURE_SITE}/${FIXTURE_BUG}`,
    ]);

    const workflow = await host.invoke({
      kind: "concept.read",
      contributionId: "jira-workflow",
      request: { scope: scope(`issue = ${FIXTURE_BUG}`), externalId: null },
    });
    expect(workflow.objects[0]?.kind).toBe("document");
    expect(workflow.objects[0]?.renderings.agentContent).toContain("id 31");

    const content = await host.invoke({
      kind: "content.render",
      contributionId: "jira-content",
      object: ticket,
    });
    expect(content.content).toContain("Status: To Do");
    expect(content.truncated).toBeNull();

    const delta = await host.invoke({
      kind: "content.delta",
      contributionId: "jira-content",
      previous: {
        ...ticket,
        renderings: { ...ticket.renderings, agentContent: "Status: To Do" },
      },
      next: ticket,
    });
    expect(delta.content.length).toBeGreaterThan(0);

    const card = await host.invoke({
      kind: "card.render",
      contributionId: "jira-card",
      object: collection,
      detail: "expanded",
    });
    // §3.1's own verb for a collection, as a card action the host draws.
    expect(card.actions[0]?.id).toBe("expand-collection");
    expect(card.actions[0]?.writeActionId).toBeNull();

    const condition = await host.invoke({
      kind: "condition.check",
      contributionId: "jira_issue_in_status",
      input: { site: FIXTURE_SITE, key: "OXY-9", status: "done" },
    });
    expect(condition.state).toBe("met");

    const write = await host.invoke({
      kind: "write.perform",
      contributionId: "comment",
      input: { site: FIXTURE_SITE, key: FIXTURE_TICKET, body: "looks good" },
    });
    expect(write.ok).toBe(true);
    // The result is read back, never assumed (§9.2).
    expect(write.readBack?.externalId).toBe(
      `jira:ticket:${FIXTURE_SITE}/${FIXTURE_TICKET}`,
    );

    const tool = await host.invoke(
      {
        kind: "tool.call",
        contributionId: "jira_read_ticket",
        input: { site: FIXTURE_SITE, key: FIXTURE_TICKET },
      },
      { actor },
    );
    expect(tool.ok).toBe(true);
    expect(tool.content).toContain(FIXTURE_TICKET);

    const palette = await host.invoke({
      kind: "palette.invoke",
      contributionId: "jira-search-by-jql",
    });
    expect(palette).toBeUndefined();

    expect(host.health.status).toBe("ready");
  });

  it("refuses a tool call that names no calling session (principle 1)", async () => {
    const host = await load();

    await expect(
      host.invoke({
        kind: "tool.call",
        contributionId: "jira_create_issue",
        input: {
          site: FIXTURE_SITE,
          project: "OXY",
          issueType: "Task",
          summary: "nobody asked for this",
        },
      }),
    ).rejects.toBeInstanceOf(PluginCallRefusedError);
    expect(host.health.status).toBe("ready");
  });

  it("refuses an ungranted call and raises it through the approvals channel (§6.6)", async () => {
    const host = await load({ granted: grants("jira-api") });

    const error = await host
      .invoke({
        kind: "concept.read",
        contributionId: "jira-issues",
        request: { scope: scope("project = OXY"), externalId: null },
      })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );
    expect(error).toBeInstanceOf(PluginCallRefusedError);
    const raise = (error as PluginCallRefusedError).raise;
    expect(raise?.permissionId).toBe("jira-credential");
    expect(raise?.kind).toBe("tool-permission");
    // A raise blocks the call; nothing was performed and the plugin is still fine.
    expect(host.health.status).toBe("ready");
  });

  it("refuses the call when the host has no stored credential, saying so (§9.3)", async () => {
    const host = await load({ credential: null });

    const error = await host
      .invoke({
        kind: "concept.read",
        contributionId: "jira-issues",
        request: { scope: scope("project = OXY"), externalId: null },
      })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );
    expect(error).toBeInstanceOf(PluginCallRefusedError);
    expect((error as PluginCallRefusedError).reason).toContain(
      "no stored credential for jira",
    );
    // A broken connection is an integration health problem, never missing data.
    expect((error as PluginCallRefusedError).raise).toBeNull();
  });

  it("hands no credential value back to a session: the token never appears in a result", async () => {
    const host = await load();

    const tool = await host.invoke(
      {
        kind: "tool.call",
        contributionId: "jira_read_ticket",
        input: { site: FIXTURE_SITE, key: FIXTURE_TICKET },
      },
      { actor },
    );
    expect(tool.content).not.toContain(FIXTURE_TOKEN);
    expect(tool.content).not.toContain(FIXTURE_CREDENTIAL);
    // The site is not a credential, so a link out survives redaction (§9.3).
    expect(tool.content).toContain(`https://${FIXTURE_SITE}/browse/`);
  });
});
