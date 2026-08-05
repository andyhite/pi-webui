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
 * Standing instructions and proposals, over the real app (§3.8, principle 1).
 *
 * Every rule these exercise is `@plotroom/core`'s and has its own suite. What is
 * proved here is that they are *reached*: that a session cannot make an instruction
 * standing however it asks, that a proposal reaches §7.1's queue and is answerable
 * there without opening the session, that accepting one is recorded as the operator's
 * own act, and that an opted-in workstream's next run really assembles it.
 */
afterEach(cleanupHarnesses);

/** Live long enough for a session to exist and propose something. */
const alive: RuntimeScript = {
  acts: [
    {
      on: "start",
      steps: [
        { observation: { kind: "turn-started", turn: 1 } },
        { observation: { kind: "output-delta", text: "working" } },
      ],
    },
  ],
};

/** A world-scoped note: the only kind of content that may be standing (§3.8). */
async function note(
  harness: Harness,
  body = "This repository uses pnpm, never npm.",
): Promise<string> {
  const created = await harness.ok("/notes", {
    method: "POST",
    body: { title: "House rules", body },
  });
  return str(created, "object.id");
}

async function declared(harness: Harness, objectId: string): Promise<string> {
  const created = await harness.ok("/standing-instructions", {
    method: "POST",
    body: { objectId },
  });
  return str(created, "standingInstruction.id");
}

/** A running session, so a proposal has an author and an approval a subject. */
async function session(harness: Harness): Promise<{
  readonly sessionId: string;
  readonly workstreamId: string;
}> {
  const fixture = await command(harness, { lifecycle: "open" });
  const started = await run(harness, fixture.commandId, alive);
  return {
    sessionId: str(started, "session.id"),
    workstreamId: fixture.workstream,
  };
}

describe("marking content standing (§3.8)", () => {
  it("is the operator's, and a session is told to propose instead (principle 1)", async () => {
    const harness = await boot();
    const objectId = await note(harness);

    const refused = await harness.call("/standing-instructions", {
      method: "POST",
      body: { objectId },
      actor: "session:session-1",
    });
    // A refusal with a reason, not a 403: the product wants the session to do
    // something else, and the message says what.
    expect(refused.status).toBe(409);
    expect(at(refused.body, "error.details.reason")).toBe("human_only");
    expect(String(at(refused.body, "error.message"))).toContain(
      "proposal_create",
    );
    expect(
      list(await harness.ok("/standing-instructions"), "standingInstructions"),
    ).toEqual([]);
  });

  it("refuses a local object and a kind somebody else changes, naming which rule", async () => {
    const harness = await boot();
    const workstreamId = str(
      await harness.ok("/workstreams", { method: "POST", body: {} }),
      "workstream.id",
    );
    const local = await harness.ok("/notes", {
      method: "POST",
      body: { title: "local", body: "local note", workstreamId },
    });
    const scoped = await harness.call("/standing-instructions", {
      method: "POST",
      body: { objectId: str(local, "object.id") },
    });
    expect(scoped.status).toBe(409);
    expect(at(scoped.body, "error.details.reason")).toBe("not_world_scope");
  });

  it("retires a marker without touching the content, and stops assembling it", async () => {
    const harness = await boot(repository());
    const objectId = await note(harness);
    const instructionId = await declared(harness, objectId);
    const fixture = await command(harness);

    await harness.ok(
      `/workstreams/${fixture.workstream}/standing-instructions`,
      {
        method: "POST",
        body: { instructionId },
      },
    );
    expect(
      String(
        at(
          await harness.ok(`/commands/${fixture.commandId}/preview`),
          "preview.body",
        ),
      ),
    ).toContain("pnpm");

    await harness.ok(`/standing-instructions/${instructionId}`, {
      method: "DELETE",
    });

    // Retired, not deleted: the marker is still readable, saying when it stopped.
    const rows = list(
      await harness.ok("/standing-instructions"),
      "standingInstructions",
    );
    expect(rows).toHaveLength(1);
    expect(at(rows[0], "instruction.retiredAt")).not.toBeNull();
    // And the object itself is untouched.
    expect(at(await harness.ok(`/objects/${objectId}`), "object.id")).toBe(
      objectId,
    );
    expect(
      String(
        at(
          await harness.ok(`/commands/${fixture.commandId}/preview`),
          "preview.body",
        ),
      ),
    ).not.toContain("pnpm");
  });
});

describe("opting a workstream in (§3.8)", () => {
  it("assembles the instruction into that workstream's runs and no other's", async () => {
    const harness = await boot(repository());
    const instructionId = await declared(harness, await note(harness));
    const opted = await command(harness);
    const other = await command(harness);

    await harness.ok(`/workstreams/${opted.workstream}/standing-instructions`, {
      method: "POST",
      body: { instructionId },
    });

    const preview = await harness.ok(`/commands/${opted.commandId}/preview`);
    expect(String(at(preview, "preview.body"))).toContain("pnpm");
    // First, and with no node: it is the frame the wired inputs are read in, and
    // it reached assembly through the opt-in rather than through the board.
    expect(at(preview, "preview.inputs.0.nodeId")).toBeNull();
    expect(
      String(
        at(
          await harness.ok(`/commands/${other.commandId}/preview`),
          "preview.body",
        ),
      ),
    ).not.toContain("pnpm");
  });

  it("records the opt-in's author, and opting out is recorded rather than erased", async () => {
    const harness = await boot();
    const instructionId = await declared(harness, await note(harness));
    const workstreamId = str(
      await harness.ok("/workstreams", { method: "POST", body: {} }),
      "workstream.id",
    );

    const optedIn = await harness.ok(
      `/workstreams/${workstreamId}/standing-instructions`,
      { method: "POST", body: { instructionId } },
    );
    expect(at(optedIn, "optIn.by.kind")).toBe("human");

    const optedOut = await harness.ok(
      `/workstreams/${workstreamId}/standing-instructions/${instructionId}`,
      { method: "DELETE" },
    );
    expect(at(optedOut, "optIn.optedOutAt")).not.toBeNull();

    const rows = list(
      await harness.ok("/standing-instructions"),
      "standingInstructions",
    );
    expect(list(rows[0], "optIns")).toHaveLength(1);
  });
});

describe("a session proposes and the operator accepts (principle 1, §3.8)", () => {
  it("raises a queue row answerable without opening the session, and applies it as the operator's act", async () => {
    const harness = await boot(repository());
    const objectId = await note(harness);
    const { sessionId, workstreamId } = await session(harness);

    const proposed = await harness.ok("/proposals", {
      method: "POST",
      body: {
        tool: "standing_instruction_declare",
        input: { objectId },
        rationale: "every session keeps rediscovering this",
      },
      actor: `session:${sessionId}`,
    });
    const proposalId = str(proposed, "proposal.id");
    expect(at(proposed, "proposal.state")).toBe("pending");

    // §7.1: the row is in the queue with the sentence core words for it, and it
    // carries no pre-grant option — a proposal cannot be pre-granted at all.
    const queued = await waitFor(async () => {
      const items = list(await harness.ok("/attention"), "items");
      return (
        items.find(
          (item) =>
            at(item, "feed") === "approval" &&
            at(item, "payload.capability") === "standing_instruction_declare",
        ) ?? null
      );
    }, "the proposal to reach the attention queue");
    expect(String(at(queued, "summary"))).toContain("apply everywhere");
    expect(String(at(queued, "summary"))).toContain(
      "every session keeps rediscovering this",
    );
    // A proposal is not a destruction: nothing is being removed, and the row must
    // not say so because the ask names the proposal as its target.
    expect(String(at(queued, "summary"))).not.toContain("removes");

    const accepted = await harness.ok(`/proposals/${proposalId}/accept`, {
      method: "POST",
    });
    expect(at(accepted, "proposal.state")).toBe("accepted");
    // Authored by the accepting human, never by the proposing session (§15-2).
    expect(at(accepted, "standingInstruction.declaredBy.kind")).toBe("human");

    // The queue row went with it: answering the proposal answered the approval.
    await waitFor(async () => {
      const items = list(await harness.ok("/attention"), "items");
      return items.some(
        (item) =>
          at(item, "payload.capability") === "standing_instruction_declare",
      )
        ? null
        : true;
    }, "the proposal's queue row to close");

    // And it is a real instruction: opting this workstream in assembles it.
    const instructionId = str(accepted, "standingInstruction.id");
    await harness.ok(`/workstreams/${workstreamId}/standing-instructions`, {
      method: "POST",
      body: { instructionId },
    });
    const fixture = await command(harness, { workstreamId });
    expect(
      String(
        at(
          await harness.ok(`/commands/${fixture.commandId}/preview`),
          "preview.body",
        ),
      ),
    ).toContain("pnpm");
  });

  it("refuses a second proposal for an object with one already pending", async () => {
    const harness = await boot(repository());
    const objectId = await note(harness);
    const { sessionId } = await session(harness);

    await harness.ok("/proposals", {
      method: "POST",
      body: { tool: "standing_instruction_declare", input: { objectId } },
      actor: `session:${sessionId}`,
    });

    // A second session rediscovering the same file must not raise a second ask.
    const other = await session(harness);
    const refused = await harness.call("/proposals", {
      method: "POST",
      body: { tool: "standing_instruction_declare", input: { objectId } },
      actor: `session:${other.sessionId}`,
    });
    expect(refused.status).toBe(409);
    expect(at(refused.body, "error.details.reason")).toBe("already_proposed");

    // Only the first proposal's row is in the queue.
    const items = list(await harness.ok("/attention"), "items");
    expect(
      items.filter(
        (item) =>
          at(item, "feed") === "approval" &&
          at(item, "payload.capability") === "standing_instruction_declare",
      ),
    ).toHaveLength(1);
  });

  it("refuses a proposal for an object that is already standing", async () => {
    const harness = await boot(repository());
    const objectId = await note(harness);
    const { sessionId } = await session(harness);

    const proposed = await harness.ok("/proposals", {
      method: "POST",
      body: { tool: "standing_instruction_declare", input: { objectId } },
      actor: `session:${sessionId}`,
    });
    await harness.ok(`/proposals/${str(proposed, "proposal.id")}/accept`, {
      method: "POST",
    });

    // Rediscovering the same file, once it is standing, gets nothing new to ask.
    const other = await session(harness);
    const refused = await harness.call("/proposals", {
      method: "POST",
      body: { tool: "standing_instruction_declare", input: { objectId } },
      actor: `session:${other.sessionId}`,
    });
    expect(refused.status).toBe(409);
    expect(at(refused.body, "error.details.reason")).toBe("already_standing");
  });

  it("applies nothing when the operator answers the queue row directly, until they approve it", async () => {
    const harness = await boot(repository());
    const objectId = await note(harness);
    const { sessionId } = await session(harness);

    const proposed = await harness.ok("/proposals", {
      method: "POST",
      body: { tool: "standing_instruction_declare", input: { objectId } },
      actor: `session:${sessionId}`,
    });
    const proposalId = str(proposed, "proposal.id");

    const approval = await waitFor(async () => {
      const open = list(await harness.ok("/approvals"), "approvals");
      return (
        open.find(
          (each) => at(each, "approval.kind") === "standing-instruction",
        ) ?? null
      );
    }, "the proposal's approval");

    // Denying is declining: feedback with a reason, and nothing is standing.
    await harness.ok(`/approvals/${str(approval, "approval.id")}/answer`, {
      method: "POST",
      body: { decision: "deny", reason: "that belongs in the command instead" },
    });

    const rejected = await waitFor(async () => {
      const read = await harness.ok("/standing-instructions");
      return list(read, "standingInstructions").length === 0 ? true : null;
    }, "nothing to have been marked standing");
    expect(rejected).toBe(true);

    // A second answer to the same proposal is refused: one gesture, one answer.
    const again = await harness.call(`/proposals/${proposalId}/accept`, {
      method: "POST",
    });
    expect(again.status).toBe(409);
    expect(at(again.body, "error.details.reason")).toBe("already_decided");
  });

  it("refuses a session's own acceptance and its own rejection (principle 1)", async () => {
    const harness = await boot(repository());
    const objectId = await note(harness);
    const { sessionId } = await session(harness);
    const proposed = await harness.ok("/proposals", {
      method: "POST",
      body: { tool: "standing_instruction_declare", input: { objectId } },
      actor: `session:${sessionId}`,
    });
    const proposalId = str(proposed, "proposal.id");

    for (const verb of ["accept", "reject"]) {
      const refused = await harness.call(`/proposals/${proposalId}/${verb}`, {
        method: "POST",
        body: { reason: "no thanks" },
        actor: `session:${sessionId}`,
      });
      expect(refused.status, verb).toBe(403);
    }
    expect(
      at(
        await harness.ok(`/proposals/${proposalId}/accept`, { method: "POST" }),
        "proposal.state",
      ),
    ).toBe("accepted");
  });

  it("refuses to pre-grant proposals, so an 'allow always' cannot apply one silently", async () => {
    const harness = await boot();
    const refused = await harness.call("/pre-grants", {
      method: "POST",
      body: {
        scope: { kind: "workstream", workstreamId: "ws-anything" },
        effect: "allow",
        kinds: ["standing-instruction"],
        toolPattern: "**",
      },
    });
    expect(refused.status).toBe(400);
    expect(String(at(refused.body, "error.message"))).toContain(
      "never applied silently",
    );
  });
});
