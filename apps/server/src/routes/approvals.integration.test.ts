import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeScript } from "../runtime/scripted.js";
import {
  at,
  boot,
  cleanupHarnesses,
  command,
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
