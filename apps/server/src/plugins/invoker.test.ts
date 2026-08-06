import { expect } from "vitest";
import { afterEach, beforeEach, describe, it } from "bun:test";
import {
  APPROVAL_KINDS,
  APPROVAL_TRIGGERS,
  APPROVAL_WRITE_EXTENTS,
  type Approval,
  type ApprovalAsk,
} from "@plotroom/core";
import {
  PluginHost,
  permissionRaise,
  type PermissionGrant,
} from "@plotroom/plugin-sdk";
import { Logger } from "../logging/logger.js";
import {
  PluginPermissionAskedError,
  PluginCallRefusalError,
} from "./errors.js";
import { PluginInvoker } from "./invoker.js";
import { permissionRaiseAsk } from "./raise.js";

/**
 * Where an ungranted plugin permission becomes a §6.6 approval (§10.2,
 * `docs/plugin-contract.md` §4 and §8).
 *
 * The plugin here is real and runs in the real worker host; what is stubbed is only
 * the approval authority, so what each assertion is about is unambiguous: the ask
 * that reached it, once, matched by call id.
 */
const logger = new Logger("error");

const entry = new URL(
  "./test-fixtures/needs-credential-plugin.ts",
  import.meta.url,
);

let host: PluginHost;
let raised: { readonly ask: ApprovalAsk; readonly callId: string | null }[];
let approvals: {
  forCall(sessionId: string, callId: string): Approval | undefined;
  raise(input: {
    readonly sessionId: string;
    readonly ask: ApprovalAsk;
    readonly callId?: string | null;
  }): Approval;
};
let existing: Approval | undefined;

const approval = (ask: ApprovalAsk, callId: string | null): Approval =>
  ({
    id: "approval_1",
    sessionId: "session-1",
    workstreamId: "workstream-1",
    kind: ask.kind,
    ask,
    requestId: null,
    callId,
    raisedAt: 1,
    answer: null,
    piercedPreGrant: null,
  }) as unknown as Approval;

const load = async (grants: PermissionGrant[] = []): Promise<void> => {
  host = await PluginHost.load(entry, { grants });
  await host.settled();
};

const invoker = (): PluginInvoker =>
  new PluginInvoker({
    logger,
    host: () => host,
    approvals,
  });

const read = (
  options: { readonly sessionId?: string } = {},
): Promise<unknown> =>
  invoker().invoke(
    "needs-credential",
    {
      kind: "concept.read",
      contributionId: "credentialed-tickets",
      request: { scope: null, externalId: null },
    },
    options.sessionId === undefined ? {} : { sessionId: options.sessionId },
  );

beforeEach(() => {
  raised = [];
  existing = undefined;
  approvals = {
    forCall: () => existing,
    raise: (input) => {
      raised.push({ ask: input.ask, callId: input.callId ?? null });
      const made = approval(input.ask, input.callId ?? null);
      existing = made;
      return made;
    },
  };
});

afterEach(async () => {
  await host?.dispose();
});

describe("a plugin's ungranted permission (§10.2, §6.6)", () => {
  it("raises a §6.6 approval against the calling session and leaves the call blocked", async () => {
    await load();

    const error = await read({ sessionId: "session-1" }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(PluginPermissionAskedError);
    const asked = error as PluginPermissionAskedError;
    // Blocked, not settled: there is an approval and there is no result.
    expect(asked.status).toBe(202);
    expect(asked.approval?.id).toBe("approval_1");
    expect(asked.permissionId).toBe("fake-token");

    expect(raised).toHaveLength(1);
    const ask = raised[0]?.ask as ApprovalAsk;
    expect(ask.kind).toBe("tool-permission");
    expect(ask.trigger).toBe("outside-policy");
    expect(ask.summary).toContain("to read the fake source at all");
    // Already redacted by construction: the raise names the credential, never a
    // value (§9.3) — this ask goes out over a notification route (§7.3).
    expect(JSON.stringify(ask)).not.toContain("token=");
  });

  it("finds the ask already waiting on a retry rather than asking twice (principle 9)", async () => {
    await load();

    await read({ sessionId: "session-1" }).catch(() => undefined);
    await read({ sessionId: "session-1" }).catch(() => undefined);

    expect(raised).toHaveLength(1);
  });

  it("refuses with the operator's grant route when there is no session to ask against", async () => {
    await load();

    const error = (await read().catch(
      (thrown: unknown) => thrown,
    )) as PluginPermissionAskedError;

    expect(error).toBeInstanceOf(PluginPermissionAskedError);
    expect(error.status).toBe(403);
    expect(error.approval).toBeNull();
    expect(error.message).toContain("/api/plugins/needs-credential/grants");
    expect(raised).toHaveLength(0);
  });

  it("raises nothing for a permission the operator already denied — it was answered", async () => {
    await load([
      {
        pluginId: "needs-credential",
        permissionId: "fake-token",
        state: "denied",
        answeredAt: 1,
      },
    ]);

    const error = await read({ sessionId: "session-1" }).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(PluginCallRefusalError);
    expect(raised).toHaveLength(0);
  });

  it("refuses a granted permission whose credential nothing has stored, saying so (§9.3)", async () => {
    await load([
      {
        pluginId: "needs-credential",
        permissionId: "fake-token",
        state: "granted",
        answeredAt: 1,
      },
    ]);

    const error = (await read({ sessionId: "session-1" }).catch(
      (thrown: unknown) => thrown,
    )) as PluginCallRefusalError;

    // A broken or absent connection is an integration health problem, never
    // mysteriously missing data.
    expect(error).toBeInstanceOf(PluginCallRefusalError);
    expect(error.message).toContain("no stored credential");
    expect(raised).toHaveLength(0);
  });
});

describe("the raise's vocabulary is §6.6's own (the plugin-contract seam)", () => {
  it("maps every field of a PermissionRaise onto an ApprovalAsk with no translation", () => {
    const raise = permissionRaise({
      pluginId: "needs-credential",
      request: {
        id: "fake-token",
        kind: "filesystem",
        scope: { kind: "filesystem", roots: ["/tmp/x"], access: "read-write" },
        reason: "to write the thing",
        requiredToLoad: false,
      },
      tool: "some-contribution",
    });

    const ask = permissionRaiseAsk(raise);

    // The compile-time assertions live in `raise.ts`; these are the runtime half:
    // every enum member the raise uses is a member of core's own list, so a drift
    // in either vocabulary is caught by the build *and* named here.
    expect(APPROVAL_KINDS).toContain(ask.kind);
    expect(APPROVAL_TRIGGERS).toContain(ask.trigger);
    expect(APPROVAL_WRITE_EXTENTS).toContain(ask.writeExtent);
    expect(ask).toEqual({
      kind: "tool-permission",
      trigger: "outside-policy",
      tool: "some-contribution",
      summary: raise.summary,
      writeExtent: "paths",
      paths: ["/tmp/x"],
      world: null,
      target: null,
    });
  });
});
