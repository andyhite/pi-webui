import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { humanAuthor, type Approval, type ApprovalAsk } from "@plotroom/core";
import { manualClock, type ManualClock } from "@plotroom/core/testing";
import {
  openDatabase,
  PluginDisablementStore,
  PluginGrantStore,
  type PlotroomDatabase,
} from "@plotroom/db";
import { createEventBus, type EventBus } from "../events/bus.js";
import { IntegrationRegistry } from "../integrations/registry.js";
import { Logger } from "../logging/logger.js";
import { createStores, type ApiStores } from "../routes/api.js";
import { PluginPermissionAskedError } from "./errors.js";
import { PluginService } from "./service.js";
import type { InBoxPluginEntry } from "./in-box.js";

/**
 * The two things about `PluginService` that only it can be asked about (§10.2).
 *
 * **An answered §6.6 approval is the operator's grant act.** The plugin here is real
 * and runs in the real worker host; what is stubbed is only the approval authority,
 * so what each assertion is about is unambiguous — the grant that was persisted, and
 * the retry that then succeeded (`docs/plugin-contract.md` §4: "grants take effect on
 * the next call; nothing is re-run").
 *
 * **A failure is one entry with one current reason.** Re-scanning a broken entry
 * replaces its row rather than adding a second, because a health surface that grew a
 * duplicate per gesture would be counting gestures rather than reporting plugins.
 */
const SECRET = "sk-fixture-token-do-not-log-me";

const NEEDS_CREDENTIAL: InBoxPluginEntry = {
  pluginId: "needs-credential",
  packageName: "fixture:needs-credential-plugin.ts",
  entry: new URL("./test-fixtures/needs-credential-plugin.ts", import.meta.url)
    .href,
};

let dir: string;
let state: PlotroomDatabase;
let bus: EventBus;
let clock: ManualClock;
let stores: ApiStores;
let grants: PluginGrantStore;
let disablements: PluginDisablementStore;
let service: PluginService;
let raised: Approval[];

/** The one approval an ungranted reach raises, recorded rather than answered. */
const approval = (ask: ApprovalAsk, callId: string | null): Approval =>
  ({
    id: `appr_${raised.length + 1}`,
    sessionId: "sess_1",
    workstreamId: "ws_1",
    kind: ask.kind,
    ask,
    requestId: null,
    callId,
    raisedAt: 1,
    answer: null,
    piercedPreGrant: null,
  }) as unknown as Approval;

async function boot(
  inBox: readonly InBoxPluginEntry[] = [NEEDS_CREDENTIAL],
): Promise<void> {
  service = new PluginService({
    stores,
    grants,
    disablements,
    bus,
    logger: new Logger("error"),
    integrations: new IntegrationRegistry(),
    approvals: {
      forCall: () =>
        raised.find((each) => each.answer === null && each.callId !== null),
      raise: (input) => {
        const made = approval(input.ask, input.callId ?? null);
        raised.push(made);
        return made;
      },
    },
    inBox,
  });
  await service.boot();
}

/** A connected integration with the credential the plugin's permission names. */
function connectWithCredential(): void {
  const integration = stores.integrations.connect({
    pluginId: "needs-credential",
    producerId: "credentialed-tickets",
    name: "Fake source",
    system: "credentialed-tickets",
    scope: null,
  });
  stores.credentials.put(integration.id, "fake-token", SECRET);
}

const read = (): Promise<unknown> =>
  service.invoker.invoke(
    "needs-credential",
    {
      kind: "concept.read",
      contributionId: "credentialed-tickets",
      request: { scope: null, externalId: null },
    },
    { sessionId: "sess_1", workstreamId: "ws_1" },
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-plugin-service-"));
  state = openDatabase({ stateDir: dir });
  clock = manualClock(1_000);
  bus = createEventBus(clock.now);
  stores = createStores(state, bus, clock.now);
  grants = new PluginGrantStore(state, clock.now);
  disablements = new PluginDisablementStore(state, clock.now);
  raised = [];
});

afterEach(async () => {
  await service?.shutdown();
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The answer, published the way `ApprovalService` publishes it (§6.6). */
function answer(decision: "approve-once" | "deny"): void {
  const pending = raised.at(-1);
  if (pending === undefined) throw new Error("nothing was raised");
  const answered = {
    ...pending,
    answer: {
      decision,
      reason: decision === "deny" ? "not this plugin" : null,
      by: humanAuthor,
      at: clock.now(),
    },
  } as Approval;
  raised[raised.length - 1] = answered;
  bus.publish({
    entity: "approval",
    verb: "updated",
    approval: answered,
    attention: null,
    author: humanAuthor,
  });
}

describe("an answered approval is the operator's grant act (§10.2, §6.6)", () => {
  it("persists the grant, pushes it into the running host, and the retry succeeds", async () => {
    await boot();
    connectWithCredential();

    // Never-asked: the reach raises and the call stays blocked, with no result.
    const asked = await read().catch((thrown: unknown) => thrown);
    expect(asked).toBeInstanceOf(PluginPermissionAskedError);
    expect(grants.forPlugin("needs-credential")).toEqual([]);

    answer("approve-once");

    // Persisted, so a restart does not ask the operator the same question again.
    expect(grants.forPlugin("needs-credential")).toEqual([
      {
        pluginId: "needs-credential",
        permissionId: "fake-token",
        state: "granted",
        answeredAt: 1_000,
      },
    ]);
    // And the health surface says so without a re-scan or a restart.
    expect(service.get("needs-credential").permissions[0]?.state).toBe(
      "granted",
    );

    // The retry is the proof: the host has the grant, so the credential is
    // injected for that one call — and redacted back out of the result (§9.3).
    const result = JSON.stringify(await read());
    expect(result).not.toContain(SECRET);
    expect(result).toContain("[redacted:fake-token]");
  });

  it("records a denial as denied, so the same reach raises nothing again", async () => {
    await boot();
    connectWithCredential();
    await read().catch(() => undefined);

    answer("deny");

    expect(grants.forPlugin("needs-credential")[0]?.state).toBe("denied");
    const before = raised.length;
    // Refused, not asked: it was answered, and re-raising would be asking again
    // with nobody having changed anything.
    const refused = await read().catch((thrown: unknown) => thrown);
    expect(refused).toBeInstanceOf(Error);
    expect(refused).not.toBeInstanceOf(PluginPermissionAskedError);
    expect(raised).toHaveLength(before);
  });

  it("ignores an approval it never raised, and an unanswered one", async () => {
    await boot();
    connectWithCredential();

    // An approval from somewhere else entirely (a claim, a destruction) must not
    // grant a plugin anything: the pair is remembered from the raise, not guessed.
    bus.publish({
      entity: "approval",
      verb: "updated",
      approval: {
        ...approval(
          {
            kind: "destruction",
            trigger: "destruction",
            tool: "object_delete",
            summary: "delete obj_1",
            writeExtent: "none",
            paths: [],
            world: null,
            target: { kind: "object", id: "obj_1" },
          },
          null,
        ),
        answer: {
          decision: "approve-once",
          reason: null,
          by: humanAuthor,
          at: clock.now(),
        },
      } as Approval,
      attention: null,
      author: humanAuthor,
    });
    expect(grants.forPlugin("needs-credential")).toEqual([]);

    // And a raise that has not been answered yet grants nothing either.
    await read().catch(() => undefined);
    const pending = raised.at(-1);
    if (pending === undefined) throw new Error("nothing was raised");
    bus.publish({
      entity: "approval",
      verb: "updated",
      approval: pending,
      attention: null,
      author: humanAuthor,
    });
    expect(grants.forPlugin("needs-credential")).toEqual([]);
  });
});

describe("what could not be installed (§10.2, principle 12)", () => {
  const BROKEN: InBoxPluginEntry = {
    pluginId: "missing",
    packageName: "@plotroom/plugin-that-does-not-exist",
  };

  it("reports one entry once, however many times it is re-scanned", async () => {
    await boot([BROKEN]);
    expect(service.failures()).toHaveLength(1);
    const first = service.failures()[0];
    expect(first?.origin).toBe("in-box");

    // The same install attempted again is the same entry with the same reason,
    // not a second row on the health surface.
    const again = await service.install(
      "@plotroom/plugin-that-does-not-exist",
      {
        kind: "human",
      },
    );
    expect(again.installed).toBe(false);
    expect(service.failures()).toHaveLength(2); // one per origin, not per attempt
    const third = await service.install(
      "@plotroom/plugin-that-does-not-exist",
      { kind: "human" },
    );
    expect(third.installed).toBe(false);
    expect(service.failures()).toHaveLength(2);
  });

  it("hands the failure back to the call that produced it", async () => {
    await boot([]);
    const result = await service.install("./not-a-module-at-all.js", {
      kind: "human",
    });
    expect(result.installed).toBe(false);
    if (result.installed) return;
    // This call's own reason, not whatever was recorded most recently: a second
    // install in flight must not answer with somebody else's failure.
    expect(result.failure.entry).toContain("not-a-module-at-all");
  });
});

describe("the operator's disable survives a restart (§10.2)", () => {
  it("boots a disabled plugin into disabled, and an enable is remembered too", async () => {
    await boot();
    expect(service.get("needs-credential").state).toBe("enabled");

    await service.disable("needs-credential", { kind: "human" });
    expect(disablements.list()).toEqual(["needs-credential"]);

    // A restart, over the same state directory: the registry's own state is a
    // running process's property, so this row is what carries the decision.
    await service.shutdown();
    await boot();
    const afterRestart = service.get("needs-credential");
    expect(afterRestart.state).toBe("disabled");
    expect(afterRestart.health).toBe("disabled");

    await service.enable("needs-credential", { kind: "human" });
    expect(disablements.list()).toEqual([]);
    await service.shutdown();
    await boot();
    expect(service.get("needs-credential").state).toBe("enabled");
  });

  it("forgets the disable when the plugin is removed, so re-installing it is not disabled", async () => {
    await boot();
    await service.disable("needs-credential", { kind: "human" });
    await service.remove("needs-credential", { kind: "human" });
    expect(disablements.list()).toEqual([]);

    await service.shutdown();
    await boot();
    expect(service.get("needs-credential").state).toBe("enabled");
  });
});
