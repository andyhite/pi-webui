import {
  PluginCallRefusedError,
  PluginHost,
  PluginRegistry,
  type CoreId,
  type PermissionGrant,
  type PluginActor,
} from "@plotroom/plugin-sdk";
import { afterEach, describe, expect, it } from "bun:test";

import { FIXTURE_HEAD_SHA, FIXTURE_TOKEN } from "./testing/github-fixture.js";

/**
 * The GitHub plugin **in the real worker_threads host**, with a recorded GitHub
 * behind it: the manifest, the conformance check, the permission gate, the credential
 * injection and every dispatch are the product's, and the only thing that is not real
 * is GitHub. No test here can reach the network.
 *
 * The shipped entry (`src/index.ts`, `fetch`-backed, #315: no build) is loaded too, so what the
 * product would install is proved to conform and load — it is simply never invoked,
 * because invoking it would be the live call this file exists to avoid.
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
    pluginId: "github",
    permissionId,
    state: "granted" as const,
    answeredAt: 1,
  }));

const allGrants = grants("github-api", "github-token");

const hosts: PluginHost[] = [];
const registries: PluginRegistry[] = [];

const load = async (
  options: {
    readonly granted?: PermissionGrant[];
    readonly token?: string | null;
    readonly entry?: URL;
  } = {},
): Promise<PluginHost> => {
  const host = await PluginHost.load(options.entry ?? stubEntry, {
    grants: options.granted ?? allGrants,
    credentials: () =>
      options.token === undefined ? FIXTURE_TOKEN : options.token,
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

describe("the GitHub plugin in the worker host (§9.4, §10.2)", () => {
  it("conforms, loads, and declares what §9.4 asks of it", async () => {
    const host = await load();

    expect(host.health.status).toBe("ready");
    const descriptor = host.descriptor;
    expect(descriptor?.id).toBe("github");
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
    ).toEqual(["irreversible", "reversible", "reversible", "reversible"]);
    // The network scope names one host, not the internet.
    expect(
      descriptor?.permissions.find((one) => one.id === "github-api")?.scope,
    ).toEqual({ kind: "network", hosts: ["api.github.com"] });
  });

  it("the shipped, fetch-backed entry conforms and loads too", async () => {
    const host = await load({ entry: shippedEntry });
    expect(host.health.status).toBe("ready");
    expect(host.descriptor?.id).toBe("github");
  });

  it("installs, enables and disables through the registry without a restart (§10.2)", async () => {
    const events: string[] = [];
    const registry = new PluginRegistry({
      grantsFor: () => allGrants,
      host: { credentials: () => FIXTURE_TOKEN, callTimeoutMs: 15_000 },
      onEvent: (event) =>
        events.push(`${event.state}:${event.health?.status ?? "none"}`),
    });
    registries.push(registry);

    const installed = await registry.install(stubEntry, "in-box");
    expect(installed.installed).toBe(true);
    await registry.enable("github");
    const host = registry.host("github");
    expect(host?.health.status).toBe("ready");
    await registry.disable("github");
    expect(registry.get("github")?.state).toBe("disabled");
    expect(events[0]).toBe("installed:none");
  });

  it("serves an invocation for every dispatchable contribution it declares", async () => {
    const host = await load();

    const read = await host.invoke({
      kind: "concept.read",
      contributionId: "pull-requests",
      request: { scope: "repo:acme/app", externalId: null },
    });
    const pull = read.objects[0];
    if (pull === undefined) {
      throw new Error("the pull request producer returned nothing");
    }
    // A successful read proves the host injected the credential: the recorded
    // GitHub answers 401 to a request without it.
    expect(pull.externalId).toBe("github:pull_request:acme/app#12");
    expect(read.unavailable).toEqual([]);

    const reviews = await host.invoke({
      kind: "concept.read",
      contributionId: "reviews",
      request: { scope: "repo:acme/app pull:12", externalId: null },
    });
    expect(reviews.objects[0]?.kind).toBe("review");

    const tickets = await host.invoke({
      kind: "concept.read",
      contributionId: "issues-as-tickets",
      request: { scope: "repo:acme/app", externalId: null },
    });
    expect(tickets.objects.map((one) => one.externalId)).toEqual([
      "github:ticket:acme/app#7",
    ]);

    const repository = await host.invoke({
      kind: "concept.read",
      contributionId: "repository-metadata",
      request: { scope: "repo:acme/app", externalId: null },
    });
    expect(repository.objects[0]?.kind).toBe("document");

    const content = await host.invoke({
      kind: "content.render",
      contributionId: "github-content",
      object: pull,
    });
    expect(content.content).toContain("Branches: feat/mid-drag → main");
    expect(content.truncated).toBeNull();

    const delta = await host.invoke({
      kind: "content.delta",
      contributionId: "github-content",
      previous: {
        ...pull,
        renderings: { ...pull.renderings, agentContent: "State: open" },
      },
      next: pull,
    });
    expect(delta.content.length).toBeGreaterThan(0);

    const card = await host.invoke({
      kind: "card.render",
      contributionId: "github-card",
      object: pull,
      detail: "expanded",
    });
    // Clone-from-a-pull-request, as a card action the host draws (§3.4, §10.1).
    expect(card.actions[0]?.id).toBe("clone-from-pull-request");
    expect(card.actions[0]?.writeActionId).toBeNull();

    const condition = await host.invoke({
      kind: "condition.check",
      contributionId: "github_checks_green",
      input: { repository: "acme/app", ref: FIXTURE_HEAD_SHA },
    });
    expect(condition.state).toBe("met");

    const write = await host.invoke({
      kind: "write.perform",
      contributionId: "comment",
      input: { repository: "acme/app", number: 7, body: "looks good" },
    });
    expect(write.ok).toBe(true);
    // The result is read back, never assumed (§9.2).
    expect(write.readBack?.externalId).toBe("github:ticket:acme/app#7");

    const tool = await host.invoke(
      {
        kind: "tool.call",
        contributionId: "github_read_pull_request",
        input: { repository: "acme/app", number: 12 },
      },
      { actor },
    );
    expect(tool.ok).toBe(true);
    expect(tool.content).toContain("acme/app#12");

    const palette = await host.invoke({
      kind: "palette.invoke",
      contributionId: "github-clone-from-pull-request",
    });
    expect(palette).toBeUndefined();

    expect(host.health.status).toBe("ready");
  });

  it("refuses a tool call that names no calling session (principle 1)", async () => {
    const host = await load();

    await expect(
      host.invoke({
        kind: "tool.call",
        contributionId: "github_merge_pull_request",
        input: { repository: "acme/app", number: 12 },
      }),
    ).rejects.toBeInstanceOf(PluginCallRefusedError);
    expect(host.health.status).toBe("ready");
  });

  it("refuses an ungranted call and raises it through the approvals channel (§6.6)", async () => {
    const host = await load({ granted: grants("github-api") });

    const error = await host
      .invoke({
        kind: "concept.read",
        contributionId: "pull-requests",
        request: { scope: "repo:acme/app", externalId: null },
      })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );
    expect(error).toBeInstanceOf(PluginCallRefusedError);
    const raise = (error as PluginCallRefusedError).raise;
    expect(raise?.permissionId).toBe("github-token");
    expect(raise?.kind).toBe("tool-permission");
    // A raise blocks the call; nothing was performed and the plugin is still fine.
    expect(host.health.status).toBe("ready");
  });

  it("refuses the call when the host has no stored credential, saying so (§9.3)", async () => {
    const host = await load({ token: null });

    const error = await host
      .invoke({
        kind: "concept.read",
        contributionId: "pull-requests",
        request: { scope: "repo:acme/app", externalId: null },
      })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );
    expect(error).toBeInstanceOf(PluginCallRefusedError);
    expect((error as PluginCallRefusedError).reason).toContain(
      "no stored credential for github",
    );
    // A broken connection is an integration health problem, never missing data.
    expect((error as PluginCallRefusedError).raise).toBeNull();
  });

  it("hands no credential value back to a session: the token never appears in a result", async () => {
    const host = await load();

    const tool = await host.invoke(
      {
        kind: "tool.call",
        contributionId: "github_read_pull_request",
        input: { repository: "acme/app", number: 12 },
      },
      { actor },
    );
    expect(tool.content).not.toContain(FIXTURE_TOKEN);
  });
});
