import { expect } from "vitest";
import { afterEach, describe, it } from "bun:test";
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
 * Approvals, end to end (§6.6, Epic 6.3's server half).
 *
 * `@plotroom/core`'s own suite proves the rules — what is proved here is that
 * they are **reached**: that an agent's destructive gesture really does not
 * delete anything, that the operator's answer really is what deletes it, that the
 * deletion is still attributed to the session that asked, and that the queue can
 * answer without opening the session (§7.1).
 */
afterEach(cleanupHarnesses);

/** A session that stays live, so it can still make calls of its own. */
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
            usage: { inputTokens: 8, outputTokens: 2, costUsd: 0.002 },
          },
        },
      ],
    },
  ],
};

/** A live session plus a note of its own to try to destroy. */
async function board(harness: Harness): Promise<{
  readonly sessionId: string;
  readonly workstream: string;
  readonly objectId: string;
}> {
  const fixture = await command(harness, { lifecycle: "open" });
  const started = await run(harness, fixture.commandId, staysOpen);
  const sessionId = str(started, "session.id");

  const note = await harness.ok("/notes", {
    method: "POST",
    body: {
      title: "the arrangement",
      body: "something the operator authored",
      workstreamId: fixture.workstream,
    },
  });

  return {
    sessionId,
    workstream: fixture.workstream,
    objectId: str(note, "object.id"),
  };
}

async function pendingApprovals(harness: Harness): Promise<unknown[]> {
  return list(await harness.ok("/approvals"), "approvals");
}

describe("a session destroying authored state (§6.6, principle 10)", () => {
  it("raises an approval instead of deleting, and the operator's answer deletes it", async () => {
    const harness = await boot(repository());
    const { sessionId, objectId } = await board(harness);

    const attempt = await harness.call(`/objects/${objectId}`, {
      method: "DELETE",
      actor: `session:${sessionId}`,
    });

    // 202: accepted and waiting on a person. Not a success (nothing was
    // deleted) and not a refusal (nothing said no).
    expect(attempt.status).toBe(202);
    expect(at(attempt.body, "executed")).toBe(false);
    const approvalId = str(attempt.body, "approval.id");

    // Nothing was destroyed while the operator had not answered.
    expect(at(await harness.ok(`/objects/${objectId}`), "object.id")).toBe(
      objectId,
    );

    // The row carries what answering needs, without opening the session (§7.1).
    const row = (await pendingApprovals(harness))[0];
    expect(at(row, "approval.kind")).toBe("destruction");
    expect(at(row, "attention.sentence")).toContain(objectId);
    expect(list(row, "attention.answers")).toHaveLength(2);

    const answered = await harness.ok(`/approvals/${approvalId}/answer`, {
      method: "POST",
      body: { decision: "approve-once" },
    });
    expect(at(answered, "executed")).toBe(true);

    // Deleted, and recoverable: principle 10 holds whoever did the deleting.
    const deleted = await harness.ok("/restorable");
    expect(list(deleted, "objects").map((row) => at(row, "id"))).toContain(
      objectId,
    );
  });

  it("records the destruction as the session's own act, not the operator's", async () => {
    const harness = await boot(repository());
    const { sessionId, workstream } = await board(harness);

    // A workstream, because its record is the one that keeps who did it: the
    // operator authorized the gesture, and the agent is what made it (§15-2).
    const victim = str(
      await harness.ok("/workstreams", { method: "POST", body: {} }),
      "workstream.id",
    );

    const attempt = await harness.call(`/workstreams/${victim}`, {
      method: "DELETE",
      actor: `session:${sessionId}`,
    });
    expect(attempt.status).toBe(202);

    await harness.ok(`/approvals/${str(attempt.body, "approval.id")}/answer`, {
      method: "POST",
      body: { decision: "approve-once" },
    });

    const read = await harness.ok(`/workstreams/${victim}`);
    expect(at(read, "deleted")).toBe(true);
    const events = list(read, "events");
    const deletion = events.find((event) => at(event, "kind") === "deleted");
    expect(at(deletion, "authorKind")).toBe("session");
    expect(at(deletion, "authorSession")).toBe(sessionId);
    expect(workstream).toBeDefined();
  });

  it("denies with a reason, deletes nothing, and says so as feedback", async () => {
    const harness = await boot(repository());
    const { sessionId, objectId } = await board(harness);

    const attempt = await harness.call(`/objects/${objectId}`, {
      method: "DELETE",
      actor: `session:${sessionId}`,
    });
    const approvalId = str(attempt.body, "approval.id");

    // A denial carries a reason: deny is feedback the session acts on (§6.6).
    const bare = await harness.call(`/approvals/${approvalId}/answer`, {
      method: "POST",
      body: { decision: "deny" },
    });
    expect(bare.status).toBe(409);
    expect(at(bare.body, "error.details.reason")).toBe("deny_needs_reason");

    const denied = await harness.ok(`/approvals/${approvalId}/answer`, {
      method: "POST",
      body: { decision: "deny", reason: "that note is mine" },
    });
    expect(at(denied, "executed")).toBe(false);
    expect(at(await harness.ok(`/objects/${objectId}`), "object.id")).toBe(
      objectId,
    );

    // The next attempt is refused with the operator's own words rather than
    // silently raising a second approval for the same gesture.
    const again = await harness.call(`/objects/${objectId}`, {
      method: "DELETE",
      actor: `session:${sessionId}`,
    });
    expect(again.status).toBe(403);
    expect(str(again.body, "error.message")).toContain("that note is mine");
  });

  it("keeps the first answer: a second is refused, not applied", async () => {
    const harness = await boot(repository());
    const { sessionId, objectId } = await board(harness);

    const attempt = await harness.call(`/objects/${objectId}`, {
      method: "DELETE",
      actor: `session:${sessionId}`,
    });
    const approvalId = str(attempt.body, "approval.id");

    await harness.ok(`/approvals/${approvalId}/answer`, {
      method: "POST",
      body: { decision: "approve-once" },
    });

    const second = await harness.call(`/approvals/${approvalId}/answer`, {
      method: "POST",
      body: { decision: "deny", reason: "changed my mind" },
    });
    expect(second.status).toBe(409);
    expect(at(second.body, "error.details.reason")).toBe("already_answered");
  });

  it("refuses a session answering an approval (§6.6, principle 1)", async () => {
    const harness = await boot(repository());
    const { sessionId, objectId } = await board(harness);

    const attempt = await harness.call(`/objects/${objectId}`, {
      method: "DELETE",
      actor: `session:${sessionId}`,
    });
    const approvalId = str(attempt.body, "approval.id");

    const refused = await harness.call(`/approvals/${approvalId}/answer`, {
      method: "POST",
      body: { decision: "approve-once" },
      actor: `session:${sessionId}`,
    });
    expect(refused.status).toBe(409);
    expect(at(refused.body, "error.details.reason")).toBe("human_only");
  });

  it("never lets one approval settle a different gesture", async () => {
    const harness = await boot(repository());
    const { sessionId, workstream, objectId } = await board(harness);

    const other = await harness.ok("/notes", {
      method: "POST",
      body: {
        title: "another note",
        body: "also mine",
        workstreamId: workstream,
      },
    });
    const otherId = str(other, "object.id");

    const first = await harness.call(`/objects/${objectId}`, {
      method: "DELETE",
      actor: `session:${sessionId}`,
    });
    await harness.ok(`/approvals/${str(first.body, "approval.id")}/answer`, {
      method: "POST",
      body: { decision: "approve-once" },
    });

    // An approved delete of one object does not delete another: the second
    // gesture asks on its own (`settlesAsk` matches the target, not the tool).
    const second = await harness.call(`/objects/${otherId}`, {
      method: "DELETE",
      actor: `session:${sessionId}`,
    });
    expect(second.status).toBe(202);
    expect(at(await harness.ok(`/objects/${otherId}`), "object.id")).toBe(
      otherId,
    );
  });

  it("reports an authorized effect that failed, and keeps it in the queue (#74)", async () => {
    const harness = await boot(repository());
    const { sessionId } = await board(harness);

    // The guard raises before the route looks anything up, so a gesture against
    // something that is not there is a real approval whose effect cannot succeed —
    // reachable over HTTP with nothing stubbed.
    const attempt = await harness.call("/objects/obj_no-such-object", {
      method: "DELETE",
      actor: `session:${sessionId}`,
    });
    expect(attempt.status).toBe(202);
    const approvalId = str(attempt.body, "approval.id");

    // Answered, not crashed: the operator's decision was recorded and the effect
    // failed afterwards, which is a fact about the row rather than a 500.
    const answered = await harness.ok(`/approvals/${approvalId}/answer`, {
      method: "POST",
      body: { decision: "approve-once" },
    });
    expect(at(answered, "executed")).toBe(false);
    expect(String(at(answered, "effectFailure"))).toContain(
      "obj_no-such-object",
    );

    // The answer stands: retrying it is refused rather than replayed, so a partly
    // applied effect is never run a second time.
    const again = await harness.call(`/approvals/${approvalId}/answer`, {
      method: "POST",
      body: { decision: "approve-once" },
    });
    expect(again.status).toBe(409);
    expect(at(again.body, "error.details.reason")).toBe("already_answered");

    // And §7.1 says so, as its own item asking for nothing: the operator's own
    // gesture is unfinished, which used to be invisible on every surface at once.
    const queue = await harness.ok("/attention");
    const item = list(queue, "items").find(
      (row) => at(row, "id") === `approval:${approvalId}:effect-failed`,
    );
    expect(item).toBeDefined();
    expect(String(at(item, "summary"))).toContain("could not be carried out");
    // Issue #115: the row's own payload says it has nothing to answer — a
    // surface rendering exactly this offers no approve/deny buttons, never
    // the two-button treatment the still-asking row gets.
    expect(at(item, "payload.answers")).toEqual([]);
    expect(String(at(item, "payload.effectFailure"))).toContain(
      "obj_no-such-object",
    );
    expect(at(queue, `states.approval:${approvalId}:effect-failed`)).toEqual([
      "failed",
      "anything",
    ]);

    const row = (await pendingApprovals(harness)).find(
      (entry) => at(entry, "approval.id") === approvalId,
    );
    // Not in `pending()` — it is answered — so the queue is where it lives now.
    expect(row).toBeUndefined();
    expect(
      at(await harness.ok(`/approvals/${approvalId}`), "attention.answers"),
    ).toEqual([]);
  });
});

describe("the call an approval blocks (§6.6)", () => {
  /**
   * A session that calls a tool nothing declares — so its write extent is
   * unbounded, the gate cannot answer it from claims, and §6.6 asks. The script
   * plays on once the answer arrives, which is what makes "the call unblocked"
   * an observation rather than an inference.
   */
  const callsAGatedTool: RuntimeScript = {
    acts: [
      {
        on: "start",
        steps: [
          { observation: { kind: "turn-started", turn: 1 } },
          { call: { toolName: "shell", input: { command: "rm -rf build" } } },
          {
            observation: {
              kind: "turn-ended",
              turn: 1,
              usage: { inputTokens: 8, outputTokens: 2, costUsd: 0.001 },
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

  async function blockedOnApproval(harness: Harness): Promise<{
    readonly sessionId: string;
    readonly approvalId: string;
  }> {
    const fixture = await command(harness, { lifecycle: "open" });
    const started = await run(harness, fixture.commandId, callsAGatedTool);
    const sessionId = str(started, "session.id");

    const approvalId = await waitFor(async () => {
      const rows = await pendingApprovals(harness);
      const row = rows.find(
        (entry) => at(entry, "approval.sessionId") === sessionId,
      );
      return row === undefined ? null : str(row, "approval.id");
    }, "the gated call to raise an approval");

    return { sessionId, approvalId };
  }

  async function observations(
    harness: Harness,
    sessionId: string,
  ): Promise<unknown[]> {
    return list(
      await harness.ok(`/sessions/${sessionId}/observations`),
      "observations",
    );
  }

  it("leaves the runtime call blocked until a human answers, then allows it", async () => {
    const harness = await boot(repository());
    const { sessionId, approvalId } = await blockedOnApproval(harness);

    // Blocked, not refused: the refusal that accompanies a raise is never sent,
    // because sending it would settle the call before anybody was asked.
    const waiting = await harness.ok(`/sessions/${sessionId}`);
    expect(at(waiting, "session.end")).toBeNull();
    expect(at(waiting, "status.phase.kind")).toBe("waiting-approval");
    const before = await observations(harness, sessionId);
    expect(
      before.some(
        (entry) => at(entry, "observation.kind") === "request-settled",
      ),
    ).toBe(false);

    const answered = await harness.ok(`/approvals/${approvalId}/answer`, {
      method: "POST",
      body: { decision: "approve-once" },
    });
    // The blocked call really was told: `settled` is the runtime taking it.
    expect(at(answered, "settled")).toBe(true);

    // And the session carried on from where it was waiting.
    const ended = await endedSession(harness, sessionId);
    expect(at(ended, "session.end.kind")).toBe("ended-by-user");
    const after = await observations(harness, sessionId);
    const settled = after.find(
      (entry) => at(entry, "observation.kind") === "request-settled",
    );
    expect(at(settled, "observation.outcome.kind")).toBe("allow");
    expect(
      after.some((entry) =>
        String(at(entry, "observation.text") ?? "").includes(
          "shell was approved",
        ),
      ),
    ).toBe(true);
  });

  it("returns a denial to the session structurally, as feedback rather than failure", async () => {
    const harness = await boot(repository());
    const { sessionId, approvalId } = await blockedOnApproval(harness);

    await harness.ok(`/approvals/${approvalId}/answer`, {
      method: "POST",
      body: { decision: "deny", reason: "not on this branch" },
    });

    const ended = await endedSession(harness, sessionId);
    // Denied is not failed: the session was told how to proceed and ended the
    // way its script says, not with an error (§6.6).
    expect(at(ended, "session.end.kind")).toBe("ended-by-user");

    const after = await observations(harness, sessionId);
    const settled = after.find(
      (entry) => at(entry, "observation.kind") === "request-settled",
    );
    expect(at(settled, "observation.outcome.kind")).toBe("deny");
    // The operator's own words reach the model, structurally.
    expect(String(at(settled, "observation.outcome.reason"))).toContain(
      "not on this branch",
    );
    expect(
      after.some((entry) =>
        String(at(entry, "observation.text") ?? "").includes(
          "not on this branch",
        ),
      ),
    ).toBe(true);
  });

  it("settles a re-raise of a denied call instead of wedging on it", async () => {
    const harness = await boot(repository());

    // Two gated calls in one act, declared as **the same request** (`asRequest`)
    // — which is precisely the re-raise a real runtime performs when it retries
    // a denied call. Declared rather than incidental: the runtime mints an id no
    // other request can have, so a re-raise is something a script says.
    const twice: RuntimeScript = {
      acts: [
        {
          on: "start",
          steps: [
            { observation: { kind: "turn-started", turn: 1 } },
            {
              call: {
                toolName: "shell",
                input: { command: "one" },
                asRequest: "retried",
              },
            },
            {
              call: {
                toolName: "shell",
                input: { command: "two" },
                asRequest: "retried",
              },
            },
            {
              observation: {
                kind: "turn-ended",
                turn: 1,
                usage: { inputTokens: 8, outputTokens: 2, costUsd: 0.001 },
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

    const fixture = await command(harness, { lifecycle: "open" });
    const started = await run(harness, fixture.commandId, twice);
    const sessionId = str(started, "session.id");

    const approvalId = await waitFor(async () => {
      const rows = await pendingApprovals(harness);
      const row = rows.find(
        (entry) => at(entry, "approval.sessionId") === sessionId,
      );
      return row === undefined ? null : str(row, "approval.id");
    }, "the first gated call to raise an approval");

    await harness.ok(`/approvals/${approvalId}/answer`, {
      method: "POST",
      body: { decision: "deny", reason: "not that tool" },
    });

    // The session must reach its end. Before the fix it did not: the re-raise
    // found the denied row, the pump read a pending approval and left the call
    // open, and nothing could ever settle it — `answerApproval` refuses a second
    // answer, so the session waited on a decision already made.
    const ended = await endedSession(harness, sessionId);
    expect(at(ended, "session.end.kind")).toBe("ended-by-user");

    // No second approval was raised for a question already answered, and the
    // session was told the same thing twice rather than asked twice.
    expect(await pendingApprovals(harness)).toHaveLength(0);
    const declined = list(
      await harness.ok(`/sessions/${sessionId}/observations`),
      "observations",
    ).filter((entry) =>
      String(at(entry, "observation.text") ?? "").includes("not that tool"),
    );
    expect(declined).toHaveLength(2);
  });
});

describe("pre-grants (§6.6)", () => {
  it("answers in advance for the asks it covers, and stops once withdrawn", async () => {
    const harness = await boot(repository());
    const { sessionId, workstream, objectId } = await board(harness);

    const declared = await harness.ok("/pre-grants", {
      method: "POST",
      body: {
        scope: { kind: "workstream", workstreamId: workstream },
        effect: "allow",
        kinds: ["destruction"],
        toolPattern: "object_delete",
        extents: ["none"],
      },
    });
    const preGrantId = str(declared, "preGrant.id");

    // Covered: the gesture executes, and nobody was asked.
    const covered = await harness.call(`/objects/${objectId}`, {
      method: "DELETE",
      actor: `session:${sessionId}`,
    });
    expect(covered.status).toBe(200);
    expect(await pendingApprovals(harness)).toHaveLength(0);

    await harness.ok(`/pre-grants/${preGrantId}`, { method: "DELETE" });

    const another = str(
      await harness.ok("/notes", {
        method: "POST",
        body: { title: "third", body: "mine", workstreamId: workstream },
      }),
      "object.id",
    );
    const asks = await harness.call(`/objects/${another}`, {
      method: "DELETE",
      actor: `session:${sessionId}`,
    });
    expect(asks.status).toBe(202);

    // Retired, not deleted: "revoked yesterday" and "never granted" differ.
    const preGrants = list(await harness.ok("/pre-grants"), "preGrants");
    expect(preGrants).toHaveLength(1);
    expect(at(preGrants[0], "withdrawnAt")).not.toBeNull();
  });

  it("lets a standing deny bite a call nothing would otherwise have asked about", async () => {
    const harness = await boot(repository());
    const { sessionId, workstream, objectId } = await board(harness);

    await harness.ok("/pre-grants", {
      method: "POST",
      body: {
        scope: { kind: "session", sessionId },
        effect: "deny",
        kinds: ["destruction"],
        toolPattern: "**",
        extents: ["none", "paths", "unbounded"],
      },
    });

    const refused = await harness.call(`/objects/${objectId}`, {
      method: "DELETE",
      actor: `session:${sessionId}`,
    });
    expect(refused.status).toBe(403);
    expect(str(refused.body, "error.message")).toContain(
      "refused by a standing decision",
    );
    expect(await pendingApprovals(harness)).toHaveLength(0);
    expect(workstream).toBeDefined();
  });

  it("refuses a session declaring its own pre-grant (principle 1)", async () => {
    const harness = await boot(repository());
    const { sessionId } = await board(harness);

    const refused = await harness.call("/pre-grants", {
      method: "POST",
      body: {
        scope: { kind: "session", sessionId },
        effect: "allow",
        kinds: ["destruction"],
        toolPattern: "**",
      },
      actor: `session:${sessionId}`,
    });
    expect(refused.status).toBe(400);
    expect(str(refused.body, "error.message")).toContain("human decision");
  });
});

describe("the queue answers an approval without opening the session (§7.1)", () => {
  it("carries the approval as an attention row, and clears it when answered", async () => {
    const harness = await boot(repository());
    const { sessionId, objectId } = await board(harness);

    await harness.call(`/objects/${objectId}`, {
      method: "DELETE",
      actor: `session:${sessionId}`,
    });

    const queued = await waitFor(async () => {
      const items = list(await harness.ok("/attention"), "items");
      const row = items.find((item) => at(item, "feed") === "approval");
      return row ?? null;
    }, "the approval to reach the queue");

    expect(at(queued, "payload.kind")).toBe("approval");
    expect(at(queued, "rank")).toBe(0);
    expect(at(queued, "target.sessionId")).toBe(sessionId);
    const approvalId = str(queued, "payload.approvalId");
    expect(str(queued, "id")).toBe(`approval:${approvalId}`);

    await harness.ok(`/approvals/${approvalId}/answer`, {
      method: "POST",
      body: { decision: "deny", reason: "not that one" },
    });

    const after = list(await harness.ok("/attention"), "items");
    expect(after.some((item) => at(item, "feed") === "approval")).toBe(false);
  });
});

/**
 * Reading approvals is the operator's (§6.6, principle 1, issue #119).
 *
 * `OPERATOR_ONLY_ROUTES` already recorded that these three reads have no agent
 * tool; nothing refused a session-attributed call to them, so one could ask for
 * `?status=all&sessionId=<somebody else>` and read another session's asks whole.
 * A session needs none of it: how its own blocked call was answered reaches it as
 * that call's result.
 */
describe("reading approvals is the operator's own read (§6.6)", () => {
  it("refuses a session the queue, one approval, and the standing decisions", async () => {
    const harness = await boot(repository());
    const { sessionId, objectId } = await board(harness);

    // A real approval to read, raised by this very session — so the refusal is
    // about who is asking and not about there being nothing to see.
    const attempt = await harness.call(`/objects/${objectId}`, {
      method: "DELETE",
      actor: `session:${sessionId}`,
    });
    const approvalId = str(attempt.body, "approval.id");

    for (const path of [
      "/approvals",
      "/approvals?status=all",
      `/approvals?status=all&sessionId=${sessionId}`,
      `/approvals/${approvalId}`,
      "/pre-grants",
    ]) {
      const refused = await harness.call(path, {
        actor: `session:${sessionId}`,
      });
      expect(refused.status).toBe(403);
      expect(str(refused.body, "error.message")).toContain(
        "the operator's own read",
      );
    }

    // The operator's own reads are untouched, which is what these endpoints are
    // for: the queue answers from them without opening the session (§7.1).
    expect(list(await harness.ok("/approvals"), "approvals")).toHaveLength(1);
    expect(
      at(await harness.ok(`/approvals/${approvalId}`), "approval.id"),
    ).toBe(approvalId);
    expect(list(await harness.ok("/pre-grants"), "preGrants")).toHaveLength(0);
  });

  it("still hands the session its own ask, on the call that raised it", async () => {
    const harness = await boot(repository());
    const { sessionId, objectId } = await board(harness);

    // What the closed read would have told a session about its *own* ask, the raise
    // already tells it — which is half of why closing the read costs it nothing. The
    // other half is how the answer arrives, and that is proved above: the operator's
    // decision reaches the session as a `request-settled` observation carrying the
    // outcome and their reason ("settles the blocked call", §6.6).
    //
    // Pinned because the most plausible follow-on bug to the gate is someone
    // extending its reasoning into this response and stripping the ask from it.
    const attempt = await harness.call(`/objects/${objectId}`, {
      method: "DELETE",
      actor: `session:${sessionId}`,
    });

    expect(attempt.status).toBe(202);
    expect(at(attempt.body, "approval.sessionId")).toBe(sessionId);
    expect(str(attempt.body, "attention.sentence")).toContain(objectId);
  });
});
