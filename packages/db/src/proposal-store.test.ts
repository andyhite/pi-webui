import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acceptedStandingInstruction,
  humanAuthor,
  INHERIT_APP_TOOLS,
  newProposalId,
  newStandingInstructionId,
  proposeStandingInstruction,
  sessionAuthor,
  type ObjectId,
  type SessionId,
  type ToolProposal,
} from "@plotroom/core";
import { manualClock, type ManualClock } from "@plotroom/core/testing";
import { openDatabase, type PlotroomDatabase } from "./client.js";
import { ProposalStore } from "./proposal-store.js";
import { SessionStore } from "./session-store.js";
import { WorkstreamStore } from "./workstream-store.js";

/**
 * Proposals at rest (principle 1, §3.8, migration 26).
 *
 * `ToolProposal` and one transition. The point of the round-trip assertions is that
 * a stored proposal is the same value core produced — `acceptedStandingInstruction`
 * reads its `tool`, its `state` and its `input`, so a row that lost any of them
 * would break acceptance rather than the display.
 */
let dir: string;
let state: PlotroomDatabase;
let clock: ManualClock;
let store: ProposalStore;
let sessionId: SessionId;

const OBJECT = "obj_1" as ObjectId;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-proposals-"));
  state = openDatabase({ stateDir: dir });
  clock = manualClock(1_000);
  store = new ProposalStore(state, clock.now);

  const workstreamId = new WorkstreamStore(state, clock.now).create({
    author: humanAuthor,
  }).id;
  sessionId = new SessionStore(state, clock.now).start({
    workstreamId,
    mode: "open",
    launch: {
      model: "fixture-model",
      effort: "medium",
      toolPermissions: INHERIT_APP_TOOLS,
    },
    initiatedBy: humanAuthor,
    runtime: { adapterId: "scripted", ref: "native-1" },
  }).session.id as SessionId;
});

afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

function propose(
  rationale = "every session keeps rediscovering this",
): ToolProposal {
  return store.create(
    proposeStandingInstruction({
      id: newProposalId(),
      proposedBy: sessionId,
      objectId: OBJECT,
      rationale,
      at: clock.now(),
    }),
  );
}

describe("a session's proposal (principle 1)", () => {
  it("round-trips core's own record, target and all", () => {
    const proposal = propose();

    expect(proposal.state).toBe("pending");
    expect(proposal.tool).toBe("standing_instruction_declare");
    expect(proposal.input["objectId"]).toBe(OBJECT);
    expect(proposal.rationale).toContain("rediscovering");
    // No target, deliberately: a standing instruction applies everywhere, so there
    // is nothing narrower for the lineage check to resolve (§3.8).
    expect(proposal.target).toBeNull();
    expect(proposal.decidedAt).toBeNull();
    expect(store.pending()).toHaveLength(1);
    expect(store.forSession(sessionId)).toHaveLength(1);
  });

  it("is idempotent in its own id: a replayed gesture writes one row (principle 9)", () => {
    const id = newProposalId();
    const build = () =>
      proposeStandingInstruction({
        id,
        proposedBy: sessionId,
        objectId: OBJECT,
        at: clock.now(),
      });

    store.create(build());
    store.create(build());
    expect(store.list()).toHaveLength(1);
  });

  it("refuses a session's own acceptance, and records the human's", () => {
    const proposal = propose();

    const refused = store.decide(
      proposal.id,
      "accept",
      sessionAuthor(sessionId),
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.reason).toBe("human_only");
    // Nothing moved: a refused decision is not a decision.
    expect(store.get(proposal.id).state).toBe("pending");

    clock.advance(30);
    const accepted = store.decide(proposal.id, "accept", humanAuthor);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.proposal.state).toBe("accepted");
    expect(accepted.proposal.decidedAt).toBe(1_030);
    expect(store.pending()).toEqual([]);
  });

  it("refuses a second decision, in either direction (principle 9)", () => {
    const proposal = propose();
    expect(store.decide(proposal.id, "reject", humanAuthor).ok).toBe(true);

    const again = store.decide(proposal.id, "accept", humanAuthor);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.refusal.reason).toBe("already_decided");
    expect(store.get(proposal.id).state).toBe("rejected");
  });

  it("is a record core's acceptance path can act on, unchanged by storage", () => {
    const proposal = propose();
    const accepted = store.decide(proposal.id, "accept", humanAuthor);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    // The whole reason the round-trip matters: this is the only path from a
    // proposal to a marker, and it reads the stored record's own fields.
    const applied = acceptedStandingInstruction({
      id: newStandingInstructionId(),
      proposal: accepted.proposal,
      object: { objectId: OBJECT, kind: "note", scope: "world" },
      by: humanAuthor,
      at: clock.now(),
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    // Authored by the accepting human, never by the proposing session (§15-2).
    expect(applied.value.declaredBy).toEqual(humanAuthor);
  });

  it("cannot be applied while pending, from the stored record either", () => {
    const proposal = propose();
    const applied = acceptedStandingInstruction({
      id: newStandingInstructionId(),
      proposal,
      object: { objectId: OBJECT, kind: "note", scope: "world" },
      by: humanAuthor,
      at: clock.now(),
    });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.refusal.reason).toBe("not_accepted");
  });
});
