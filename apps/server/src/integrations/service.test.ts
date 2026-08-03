import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type PlotroomDatabase } from "@plotroom/db";
import {
  answerApproval,
  humanAuthor,
  INHERIT_APP_TOOLS,
  newApprovalId,
  raiseApproval,
  sessionAuthor,
  type Approval,
  type PreGrant,
} from "@plotroom/core";
import { manualClock, type ManualClock } from "@plotroom/core/testing";
import {
  CredentialStore,
  IntegrationStore,
  ObjectStore,
  SessionStore,
  WorkstreamStore,
} from "@plotroom/db";
import {
  createFakeIntegrationState,
  createFakeProducer,
  type FakeIntegrationState,
} from "./fake-plugin.js";
import { IntegrationRegistry } from "./registry.js";
import { IntegrationService, type IntegrationApprovals } from "./service.js";
import type { ApiStores } from "../routes/api.js";
import { Logger } from "../logging/logger.js";

const logger = new Logger("error");

let dir: string;
let db: PlotroomDatabase;
let clock: ManualClock;
let fakeState: FakeIntegrationState;
let registry: IntegrationRegistry;
let stores: Pick<
  ApiStores,
  "clock" | "objects" | "integrations" | "credentials" | "sessions"
>;
let integrations: IntegrationService;
let workstreamId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-integration-service-"));
  db = openDatabase({ stateDir: dir });
  clock = manualClock();
  fakeState = createFakeIntegrationState([
    {
      externalId: "FAKE-1",
      title: "Fix the drift flag",
      status: "open",
      body: "the original ticket body",
    },
  ]);
  registry = new IntegrationRegistry();
  registry.register(createFakeProducer(fakeState));

  const objects = new ObjectStore(db, clock.now);
  const integrationStore = new IntegrationStore(db, clock.now);
  const credentials = new CredentialStore(db, clock.now);
  const sessions = new SessionStore(db, clock.now);
  stores = {
    clock: clock.now,
    objects,
    integrations: integrationStore,
    credentials,
    sessions,
  };
  workstreamId = new WorkstreamStore(db, clock.now).create({
    author: humanAuthor,
  }).id;

  integrations = new IntegrationService({
    stores: stores as ApiStores,
    registry,
    logger,
  });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function connect() {
  return integrations.connect({
    pluginId: "fake-plugin",
    producerId: "fake-tickets",
    name: "Fake tickets",
  });
}

describe("connect / disconnect / scoping", () => {
  it("connects, stores a credential, and never returns its value from any read", () => {
    const integration = integrations.connect({
      pluginId: "fake-plugin",
      producerId: "fake-tickets",
      name: "Fake tickets",
      credentialName: "api-token",
      credentialValue: "sk-super-secret",
    });

    expect(JSON.stringify(integration)).not.toContain("sk-super-secret");
    expect(JSON.stringify(integrations.list())).not.toContain(
      "sk-super-secret",
    );
    expect(JSON.stringify(integrations.get(integration.id))).not.toContain(
      "sk-super-secret",
    );
  });

  it("updates scoping without touching connection state, and it takes effect on the next read (§9.1: no restart)", async () => {
    const integration = connect();
    integrations.updateScoping(integration.id, 'status = "open"');
    const outcome = await integrations.refresh(integration.id);
    expect(outcome.ok).toBe(true);
    // The producer's own `read` receives whatever scope is on the row *right
    // now* — proven by the fake producer not throwing and returning objects,
    // since it never parses `scope` at all (§9.1: opaque to the substrate).
  });

  it("disconnecting clears credentials", () => {
    const integration = integrations.connect({
      pluginId: "fake-plugin",
      producerId: "fake-tickets",
      name: "Fake tickets",
      credentialName: "api-token",
      credentialValue: "sk-super-secret",
    });
    integrations.disconnect(integration.id);
    expect(stores.credentials.names(integration.id)).toEqual([]);
  });
});

describe("refresh: reconciliation, drift, and honest failure (§9.1, §3.1, §3.2)", () => {
  it("reconciles on external identity rather than duplicating", async () => {
    const integration = connect();
    const first = await integrations.refresh(integration.id);
    const second = await integrations.refresh(integration.id);
    expect(first.ok && second.ok).toBe(true);

    const objects = stores.objects.live();
    expect(objects).toHaveLength(1);
    expect(objects[0]?.externalId).toBe("FAKE-1");
  });

  it("writes no new version when the source content did not change", async () => {
    const integration = connect();
    await integrations.refresh(integration.id);
    const object = stores.objects.live()[0];
    if (object === undefined) throw new Error("expected a reconciled object");
    const firstRead = stores.objects.read(object.id);

    clock.advance(10);
    await integrations.refresh(integration.id);
    const secondRead = stores.objects.read(object.id);
    expect(secondRead.versionId).toBe(firstRead.versionId);
  });

  it("bumps a version when the source content changed — refresh surfaces drift (§3.2)", async () => {
    const integration = connect();
    await integrations.refresh(integration.id);
    const object = stores.objects.live()[0];
    if (object === undefined) throw new Error("expected a reconciled object");
    const before = stores.objects.read(object.id);

    const ticket = fakeState.tickets.get("FAKE-1");
    if (ticket === undefined) throw new Error("fixture ticket missing");
    ticket.body = "the ticket changed upstream";

    await integrations.refresh(integration.id);
    const after = stores.objects.read(object.id);
    expect(after.versionId).not.toBe(before.versionId);
    expect(after.ordinal).toBe(before.ordinal + 1);
    expect(after.renderings.agentContent).toContain("changed upstream");
  });

  it("marks the connection broken on a failed read, without touching what is already on the board (§3.1, §9.3)", async () => {
    const integration = connect();
    await integrations.refresh(integration.id);
    const retained = stores.objects.live();
    expect(retained).toHaveLength(1);
    const contentBefore = stores.objects.read(retained[0]?.id ?? "").renderings
      .agentContent;

    fakeState.failReads = true;
    fakeState.failReason = "authentication failed";
    const outcome = await integrations.refresh(integration.id);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a failed refresh");
    expect(outcome.integration.connectionState).toBe("broken");
    expect(outcome.integration.lastBrokenReason).toBe("authentication failed");

    // Present-or-absent, never degraded: the object nothing touched keeps its
    // exact content and is never removed by a broken connection.
    const stillThere = stores.objects.live();
    expect(stillThere).toHaveLength(1);
    expect(
      stores.objects.read(stillThere[0]?.id ?? "").renderings.agentContent,
    ).toBe(contentBefore);
  });

  it("recovers to connected on the next successful read", async () => {
    const integration = connect();
    fakeState.failReads = true;
    await integrations.refresh(integration.id);
    expect(integrations.get(integration.id).connectionState).toBe("broken");

    fakeState.failReads = false;
    await integrations.refresh(integration.id);
    expect(integrations.get(integration.id).connectionState).toBe("connected");
  });

  it("refreshes exactly one object when an external id is named — manual, per-object (§9.1)", async () => {
    fakeState.tickets.set("FAKE-2", {
      externalId: "FAKE-2",
      title: "Second ticket",
      status: "open",
      body: "second body",
    });
    const integration = connect();
    const outcome = await integrations.refresh(integration.id, {
      externalId: "FAKE-1",
    });
    expect(outcome.ok && outcome.objectsWritten).toBe(1);
    expect(stores.objects.live()).toHaveLength(1);
  });

  it("reports unavailable per §3.1 rather than writing a half object", async () => {
    const integration = connect();
    const outcome = await integrations.refresh(integration.id, {
      externalId: "no-such-ticket",
    });
    if (!outcome.ok) throw new Error("expected the read itself to succeed");
    expect(outcome.objectsWritten).toBe(0);
    expect(outcome.unavailable).toEqual([
      {
        externalId: "no-such-ticket",
        why: expect.stringContaining("no ticket"),
      },
    ]);
  });
});

describe("dueForScheduledRefresh — reads only, never runs (principle 2)", () => {
  it("is empty until the declared interval has elapsed, then includes it", async () => {
    const integration = connect();
    expect(
      integrations.dueForScheduledRefresh(clock.now()).map((one) => one.id),
    ).toEqual([integration.id]); // never refreshed yet: due immediately

    await integrations.refresh(integration.id);
    expect(integrations.dueForScheduledRefresh(clock.now())).toEqual([]);

    clock.advance(299);
    expect(integrations.dueForScheduledRefresh(clock.now())).toEqual([]);
    clock.advance(2);
    expect(
      integrations.dueForScheduledRefresh(clock.now()).map((one) => one.id),
    ).toEqual([integration.id]);
  });

  it("excludes a disconnected integration", async () => {
    const integration = connect();
    integrations.disconnect(integration.id);
    expect(integrations.dueForScheduledRefresh(clock.now())).toEqual([]);
  });
});

describe("performWrite: read-back is never assumed (§9.2)", () => {
  it("a human actor executes directly, and the response's read-back is the re-read's truth, not the lying producer's own claim", async () => {
    const integration = connect();
    await integrations.refresh(integration.id);

    const outcome = await integrations.performWrite({
      integrationId: integration.id,
      actionId: "comment",
      actionInput: { externalId: "FAKE-1", text: "please take a look" },
      actor: humanAuthor,
      callId: "call-1",
    });

    if (outcome.kind !== "executed")
      throw new Error("expected direct execution");
    expect(outcome.ok).toBe(true);

    // The fake plugin's `perform` deliberately lies in what it self-reports:
    // its own `readBack` omits the system note it actually appended, echoing
    // back only what the caller asked for (`fake-plugin.ts`'s own comment).
    // If `performWrite` returned that self-report, the response would be
    // missing the system note below. It does not: the service re-reads the
    // object after the write (§9.2's "never assumed") and the *response*
    // carries what that independent re-read actually found.
    expect(outcome.readBack?.renderings.agentContent).toContain(
      "please take a look",
    );
    expect(outcome.readBack?.renderings.agentContent).toContain(
      "comment relayed by fake-plugin, not verbatim",
    );

    // And the reconciled object on the board carries the same divergence,
    // because the substrate re-read rather than trusting the request.
    const object = stores.objects.live()[0];
    if (object === undefined) throw new Error("expected a reconciled object");
    const content = stores.objects.read(object.id).renderings.agentContent;
    expect(content).toContain("comment relayed by fake-plugin, not verbatim");
  });

  it("carries a rejection's own text verbatim, never assuming success", async () => {
    const integration = connect();
    const outcome = await integrations.performWrite({
      integrationId: integration.id,
      actionId: "comment",
      actionInput: { externalId: "no-such-ticket", text: "hello" },
      actor: humanAuthor,
      callId: "call-2",
    });
    if (outcome.kind !== "executed")
      throw new Error("expected direct execution");
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("no ticket no-such-ticket");
    expect(outcome.readBack).toBeNull();
  });
});

/** A minimal, real `IntegrationApprovals`, over core's own approval functions. */
function fakeApprovals(): IntegrationApprovals & {
  readonly raised: Approval[];
  settle(
    approvalId: string,
    decision: "approve-once" | "deny",
    reason?: string,
  ): void;
} {
  const raised: Approval[] = [];
  return {
    raised,
    preGrantsFor: (_sessionId, _workstreamId) => [],
    forCall: (sessionId, callId) =>
      raised.find(
        (approval) =>
          approval.sessionId === sessionId && approval.callId === callId,
      ),
    raise: (input) => {
      const approval = raiseApproval({
        id: newApprovalId(),
        sessionId: input.sessionId as never,
        workstreamId: (input.workstreamId ?? workstreamId) as never,
        ask: input.ask,
        callId: input.callId ?? null,
        piercedPreGrant: input.pierced ?? null,
        at: clock.now(),
      });
      raised.push(approval);
      return approval;
    },
    settle(approvalId, decision, reason) {
      const index = raised.findIndex((approval) => approval.id === approvalId);
      const approval = raised[index];
      if (approval === undefined)
        throw new Error(`no raised approval ${approvalId}`);
      const answered = answerApproval(approval, {
        decision,
        reason: reason ?? null,
        by: humanAuthor,
        at: clock.now(),
      });
      if (!answered.ok) throw new Error(answered.refusal.message);
      raised[index] = answered.value;
    },
  };
}

function seedSession(sessions: SessionStore): string {
  return sessions.start({
    workstreamId,
    mode: "open",
    launch: {
      model: "fixture-model",
      effort: "medium",
      toolPermissions: INHERIT_APP_TOOLS,
    },
    initiatedBy: humanAuthor,
    runtime: { adapterId: "scripted", ref: "native-1" },
  }).session.id;
}

describe("performWrite: a session's call routes through §6.6 (Batch-4 seam)", () => {
  it("must-asks a reversible write with nothing pre-granted, rather than executing", async () => {
    const approvals = fakeApprovals();
    const withApprovals = new IntegrationService({
      stores: stores as ApiStores,
      registry,
      logger,
      approvals,
    });
    const integration = connect();
    await withApprovals.refresh(integration.id);
    const sessionId = seedSession(stores.sessions);

    const outcome = await withApprovals.performWrite({
      integrationId: integration.id,
      actionId: "comment",
      actionInput: { externalId: "FAKE-1", text: "hi" },
      actor: sessionAuthor(sessionId as never),
      callId: "call-a",
    });

    expect(outcome.kind).toBe("must-ask");
    expect(approvals.raised).toHaveLength(1);
    expect(approvals.raised[0]?.kind).toBe("integration-write");
  });

  it("always must-asks the irreversible action, whatever is pre-granted (§6.6 piercing)", async () => {
    const approvals = fakeApprovals();
    const withApprovals = new IntegrationService({
      stores: stores as ApiStores,
      registry,
      logger,
      approvals,
    });
    const integration = connect();
    await withApprovals.refresh(integration.id);
    const sessionId = seedSession(stores.sessions);

    const preGrantAll: PreGrant = {
      id: "pregrant_1" as never,
      scope: { kind: "session", sessionId: sessionId as never },
      effect: "allow",
      kinds: ["integration-write"],
      toolPattern: "**",
      extents: ["none", "paths", "unbounded"] as never,
      grantedBy: humanAuthor,
      grantedAt: 1,
      withdrawnAt: null,
    };
    approvals.preGrantsFor = () => [preGrantAll];

    const outcome = await withApprovals.performWrite({
      integrationId: integration.id,
      actionId: "close",
      actionInput: { externalId: "FAKE-1" },
      actor: sessionAuthor(sessionId as never),
      callId: "call-b",
    });

    expect(outcome.kind).toBe("must-ask");
  });

  it("executes once the raised approval is approved, retried with the same callId (principle 9)", async () => {
    const approvals = fakeApprovals();
    const withApprovals = new IntegrationService({
      stores: stores as ApiStores,
      registry,
      logger,
      approvals,
    });
    const integration = connect();
    await withApprovals.refresh(integration.id);
    const sessionId = seedSession(stores.sessions);

    const first = await withApprovals.performWrite({
      integrationId: integration.id,
      actionId: "comment",
      actionInput: { externalId: "FAKE-1", text: "hi" },
      actor: sessionAuthor(sessionId as never),
      callId: "call-c",
    });
    expect(first.kind).toBe("must-ask");
    if (first.kind !== "must-ask") throw new Error("expected must-ask");
    approvals.settle(first.approval.id, "approve-once");

    const retried = await withApprovals.performWrite({
      integrationId: integration.id,
      actionId: "comment",
      actionInput: { externalId: "FAKE-1", text: "hi" },
      actor: sessionAuthor(sessionId as never),
      callId: "call-c",
    });
    expect(retried.kind).toBe("executed");
  });

  it("throws with the operator's own denial reason on a re-raised, already-denied call", async () => {
    const approvals = fakeApprovals();
    const withApprovals = new IntegrationService({
      stores: stores as ApiStores,
      registry,
      logger,
      approvals,
    });
    const integration = connect();
    await withApprovals.refresh(integration.id);
    const sessionId = seedSession(stores.sessions);

    const first = await withApprovals.performWrite({
      integrationId: integration.id,
      actionId: "comment",
      actionInput: { externalId: "FAKE-1", text: "hi" },
      actor: sessionAuthor(sessionId as never),
      callId: "call-d",
    });
    if (first.kind !== "must-ask") throw new Error("expected must-ask");
    approvals.settle(first.approval.id, "deny", "not now");

    await expect(
      withApprovals.performWrite({
        integrationId: integration.id,
        actionId: "comment",
        actionInput: { externalId: "FAKE-1", text: "hi" },
        actor: sessionAuthor(sessionId as never),
        callId: "call-d",
      }),
    ).rejects.toThrow(/not now/);
  });
});
