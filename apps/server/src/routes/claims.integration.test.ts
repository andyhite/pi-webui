import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, afterEach, describe, it } from "bun:test";
import type { RuntimeScript } from "../runtime/scripted.js";
import {
  at,
  boot,
  cleanupHarnesses,
  command,
  endedSession,
  list,
  repository,
  run,
  str,
  waitFor,
  type Harness,
} from "../testing/harness.js";

/**
 * Path claims, enforced (§3.4, principle 4).
 *
 * "Isolation is a guarantee, not a convention... within a workstream, it is
 * **path claims**: one writer per path, always. The model enforces both; neither
 * depends on discipline."
 *
 * These tests are about the *enforcement*, not the model — `@plotroom/core`'s own
 * suite proves the rules. What is proved here is that the rules are reached: that
 * the first session really holds the root claim, that a second session's write is
 * really refused, that the refused write really did not happen, and that the
 * operator's escape hatch really is the operator's.
 */
afterEach(cleanupHarnesses);

/** Streams one turn, writes one declared path, then ends. */
function writes(path: string): RuntimeScript {
  return {
    acts: [
      {
        on: "start",
        steps: [
          { observation: { kind: "turn-started", turn: 1 } },
          { observation: { kind: "output-delta", text: `writing ${path}` } },
          { effect: { kind: "write-file", path, content: "written" } },
          {
            observation: {
              kind: "turn-ended",
              turn: 1,
              usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.001 },
            },
          },
          {
            observation: {
              kind: "session-ended",
              reason: { kind: "ended-by-user" },
            },
          },
        ],
      },
    ],
  };
}

/** A session that stays live, so it keeps holding what it holds. */
const staysOpen: RuntimeScript = {
  acts: [
    {
      on: "start",
      steps: [
        { observation: { kind: "turn-started", turn: 1 } },
        { observation: { kind: "output-delta", text: "working" } },
        {
          observation: {
            kind: "turn-ended",
            turn: 1,
            usage: { inputTokens: 8, outputTokens: 2 },
          },
        },
      ],
    },
  ],
};

async function claims(harness: Harness, workstream: string, actor?: string) {
  return harness.ok(`/workstreams/${workstream}/claims`, {
    ...(actor === undefined ? {} : { actor }),
  });
}

describe("the root claim (§3.4's single-writer default)", () => {
  it("is granted to the first session by the operator, and subdivides nothing else", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, { lifecycle: "open" });

    const started = await run(harness, fixture.commandId, staysOpen);
    const sessionId = str(started, "session.id");

    const read = await claims(harness, fixture.workstream);
    // Inspected as the operator, so `held` is every claim in the workstream:
    // the human holds everything implicitly (§3.4).
    const held = list(read, "inspection.held").map((view) => at(view, "claim"));

    // Two claims: the operator's root claim, and the session's subdivision of it.
    // The grant is the human's, which is what makes principle 1 hold rather than
    // merely look held — no chain acquired reach it was not given.
    const sessionClaim = held.find(
      (claim) => at(claim, "holder.kind") === "session",
    );
    expect(sessionClaim).toBeDefined();
    expect(at(sessionClaim, "holder.sessionId")).toBe(sessionId);
    expect(at(sessionClaim, "grantedBy.kind")).toBe("human");
    expect(at(sessionClaim, "grantedFromClaimId")).not.toBeNull();

    // A session claim is never immortal (§3.4: "claims are leases, not locks");
    // only the operator's root claim is.
    expect(at(sessionClaim, "leaseSeconds")).toBeGreaterThan(0);
    const root = held.find((claim) => at(claim, "grantedFromClaimId") === null);
    expect(at(root, "holder.kind")).toBe("human");
    expect(at(root, "leaseSeconds")).toBeNull();
  });

  it("survives as the default: the holder's own write is allowed and recorded", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, { lifecycle: "open" });

    const started = await run(harness, fixture.commandId, writes("src/app.ts"));
    const sessionId = str(started, "session.id");
    await endedSession(harness, sessionId);

    const workspace = join(
      harness.stateDir,
      "workspaces",
      fixture.workstream,
      "src",
      "app.ts",
    );
    expect(existsSync(workspace)).toBe(true);

    // The write was allowed rather than approved: the path was covered by a
    // claim, so no approval was raised (§3.4's whole economy).
    const observations = list(
      await harness.ok(`/sessions/${sessionId}/observations`),
      "observations",
    );
    const settled = observations.find(
      (record) => at(record, "observation.kind") === "request-settled",
    );
    expect(at(settled, "observation.outcome.kind")).toBe("allow");
  });
});

describe("one writer per path (principle 4)", () => {
  it("refuses a second session's write and leaves the file alone", async () => {
    const harness = await boot(repository());
    const first = await command(harness, { lifecycle: "open" });

    // The first session takes the root claim and stays live, so it keeps it.
    const holder = await run(harness, first.commandId, staysOpen);
    const holderId = str(holder, "session.id");

    // A second command in the *same* workstream: same workspace, so the claim
    // model — not the workspace boundary — is what has to answer.
    const second = await command(harness, {
      workstreamId: first.workstream,
      lifecycle: "open",
      name: "Review it",
    });
    const intruder = await run(harness, second.commandId, writes("src/app.ts"));
    const intruderId = str(intruder, "session.id");

    const denial = await waitFor(async () => {
      const observations = list(
        await harness.ok(`/sessions/${intruderId}/observations`),
        "observations",
      );
      const settled = observations.find(
        (record) => at(record, "observation.kind") === "request-settled",
      );
      return settled ?? null;
    }, "the second session's write to be answered");

    expect(at(denial, "observation.outcome.kind")).toBe("deny");
    expect(String(at(denial, "observation.outcome.reason"))).toContain(
      "src/app.ts",
    );

    // The refusal is a refusal: nothing was written.
    expect(
      existsSync(
        join(harness.stateDir, "workspaces", first.workstream, "src", "app.ts"),
      ),
    ).toBe(false);

    // And the holder is named, so the message is actionable rather than "denied".
    expect(String(at(denial, "observation.outcome.reason"))).toContain(
      holderId,
    );
  });

  it("waitlists a request for a held path, visibly and with a position", async () => {
    const harness = await boot(repository());
    const first = await command(harness, { lifecycle: "open" });
    await run(harness, first.commandId, staysOpen);

    const second = await command(harness, {
      workstreamId: first.workstream,
      lifecycle: "open",
      name: "Review it",
    });
    const waiter = str(
      await run(harness, second.commandId, staysOpen),
      "session.id",
    );

    const requested = await harness.ok(
      `/workstreams/${first.workstream}/claims`,
      {
        method: "POST",
        body: { path: "src/app.ts" },
        actor: `session:${waiter}`,
      },
    );

    // Waitlisted or approval-required — both are visible states with a position,
    // never a silent failure and never a lie about being granted.
    const kind = str(requested, "result.kind");
    expect(["waiting", "approval-required"]).toContain(kind);
    expect(at(requested, "result.position")).toBe(1);

    // Waiting on a claim is a session *phase* (§3.6), derived by PlotRoom rather
    // than reported by the runtime.
    const session = await harness.ok(`/sessions/${waiter}`);
    expect(at(session, "status.phase.kind")).toBe("waiting-on-claim");

    // And it is readable as blocked-on accounting (§7.2's data).
    const inspected = await claims(
      harness,
      first.workstream,
      `session:${waiter}`,
    );
    expect(list(inspected, "inspection.waiting")).toHaveLength(1);
    expect(at(inspected, "inspection.waiting.0.position")).toBe(1);
    expect(list(inspected, "metrics.waits")).toHaveLength(1);
  });
});

describe("the operator's own verbs (§3.4)", () => {
  it("refuses a session the grant and the force-release", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, { lifecycle: "open" });
    const sessionId = str(
      await run(harness, fixture.commandId, staysOpen),
      "session.id",
    );

    const granted = await harness.call(
      `/workstreams/${fixture.workstream}/claim-grants`,
      {
        method: "POST",
        body: { path: "src", to: sessionId },
        actor: `session:${sessionId}`,
      },
    );
    expect(granted.status).toBe(403);

    const held = list(
      await claims(harness, fixture.workstream),
      "inspection.held",
    ).map((view) => at(view, "claim"));
    const sessionClaim = held.find(
      (claim) => at(claim, "holder.kind") === "session",
    );

    const forced = await harness.call(
      `/claims/${String(at(sessionClaim, "id"))}/force-release`,
      { method: "POST", body: {}, actor: `session:${sessionId}` },
    );
    expect(forced.status).toBe(403);
  });

  it("force-releases a wedged holder and frees the path", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, { lifecycle: "open" });
    await run(harness, fixture.commandId, staysOpen);

    const held = list(
      await claims(harness, fixture.workstream),
      "inspection.held",
    ).map((view) => at(view, "claim"));
    const sessionClaim = held.find(
      (claim) => at(claim, "holder.kind") === "session",
    );
    const claimId = String(at(sessionClaim, "id"));

    await harness.ok(`/claims/${claimId}/force-release`, {
      method: "POST",
      body: {},
    });

    const after = list(
      await claims(harness, fixture.workstream),
      "inspection.held",
    ).map((view) => at(view, "claim"));
    expect(
      after.filter((claim) => at(claim, "holder.kind") === "session"),
    ).toHaveLength(0);
  });

  it("declares a pre-granted policy inside a claim, so approval is the exception", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, { lifecycle: "open" });
    await run(harness, fixture.commandId, staysOpen);

    const held = list(
      await claims(harness, fixture.workstream),
      "inspection.held",
    ).map((view) => at(view, "claim"));
    const root = held.find((claim) => at(claim, "grantedFromClaimId") === null);

    const declared = await harness.ok(
      `/claims/${String(at(root, "id"))}/policies`,
      { method: "POST", body: { subtree: "src", effect: "allow" } },
    );
    expect(at(declared, "policy.effect")).toBe("allow");

    const inForce = list(
      await claims(harness, fixture.workstream),
      "inspection.policiesInForce",
    );
    expect(inForce).toHaveLength(1);

    await harness.ok(`/claim-policies/${str(declared, "policy.id")}`, {
      method: "DELETE",
    });
    expect(
      list(
        await claims(harness, fixture.workstream),
        "inspection.policiesInForce",
      ),
    ).toHaveLength(0);
  });
});

describe("release on session end (§3.4)", () => {
  it("frees everything a session held, without an explicit yield", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, { lifecycle: "open" });
    const sessionId = str(
      await run(harness, fixture.commandId, writes("out.txt")),
      "session.id",
    );
    await endedSession(harness, sessionId);

    const held = list(
      await claims(harness, fixture.workstream),
      "inspection.held",
    ).map((view) => at(view, "claim"));
    expect(
      held.filter((claim) => at(claim, "holder.kind") === "session"),
    ).toHaveLength(0);
  });
});
