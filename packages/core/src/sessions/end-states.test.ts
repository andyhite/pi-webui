import { describe, expect, it } from "vitest";

import { humanAuthor, sessionAuthor } from "../author.js";
import type { SessionId } from "../ids.js";
import {
  SESSION_END_KINDS,
  describeEnd,
  endStateFacts,
  endedBy,
  type SessionEnd,
} from "./end-states.js";

const EVERY_END: readonly SessionEnd[] = [
  { kind: "completed", at: 10 },
  { kind: "ended-by-user", at: 10 },
  { kind: "stopped", by: "user", at: 10 },
  { kind: "out-of-budget", scope: "workstream", at: 10 },
  { kind: "failed", message: "the tool exploded", at: 10 },
  { kind: "interrupted", message: "the server restarted", at: 10 },
];

describe("who ended it (§3.6)", () => {
  const peer = sessionAuthor("sess_peer" as SessionId);

  it("records the actor, and defaults to the operator when absent", () => {
    // Absent means the operator — the same default `X-PlotRoom-Actor` uses for an
    // omitted actor — resolved in one place so no surface invents its own.
    expect(endedBy({ kind: "ended-by-user", at: 1 })).toEqual(humanAuthor);
    expect(
      endedBy({ kind: "ended-by-user", at: 1, author: humanAuthor }),
    ).toEqual(humanAuthor);
    expect(endedBy({ kind: "ended-by-user", at: 1, author: peer })).toEqual(
      peer,
    );
  });

  it("has no actor for the ends nobody made", () => {
    expect(endedBy({ kind: "completed", at: 1 })).toBeNull();
    expect(endedBy({ kind: "failed", message: "boom", at: 1 })).toBeNull();
    expect(endedBy({ kind: "out-of-budget", scope: "run", at: 1 })).toBeNull();
  });

  it("says who in the card's own wording", () => {
    expect(describeEnd({ kind: "ended-by-user", at: 1 })).toBe("ended by you");
    expect(describeEnd({ kind: "ended-by-user", at: 1, author: peer })).toBe(
      "ended by session sess_peer",
    );
  });
});

describe("the end-state taxonomy", () => {
  it("covers every kind, with nothing left over", () => {
    expect(EVERY_END.map((end) => end.kind).sort()).toEqual(
      [...SESSION_END_KINDS].sort(),
    );

    for (const end of EVERY_END) {
      expect(endStateFacts(end).kind).toBe(end.kind);
      expect(describeEnd(end).length).toBeGreaterThan(0);
    }
  });

  it("keeps out-of-budget distinct from failure (§3.6)", () => {
    const budget = endStateFacts({
      kind: "out-of-budget",
      scope: "global",
      at: 1,
    });
    const failed = endStateFacts({ kind: "failed", message: "boom", at: 1 });

    expect(budget.failed).toBe(false);
    expect(failed.failed).toBe(true);
    // "something a retry must not blindly re-run"
    expect(budget.safeToRetryBlindly).toBe(false);
    expect(failed.safeToRetryBlindly).toBe(true);
  });

  it("keeps interrupted distinct from stopped and failed (principle 11)", () => {
    const interrupted = endStateFacts({
      kind: "interrupted",
      message: "crash",
      at: 1,
    });

    expect(interrupted.failed).toBe(false);
    expect(interrupted.stopped).toBe(false);
    // "An interrupted session is a session like any other — readable,
    // resumable, forkable"
    expect(interrupted.resumable).toBe(true);
    expect(interrupted.wantsDecision).toBe(true);
  });

  it("proves completion only for the proven outcome (principle 3)", () => {
    for (const end of EVERY_END) {
      const facts = endStateFacts(end);
      expect(facts.proven).toBe(end.kind === "completed");
      expect(facts.workIncomplete).toBe(end.kind !== "completed");
    }
  });

  it("leaves every ended session resumable (§3.6)", () => {
    for (const end of EVERY_END) {
      expect(endStateFacts(end).resumable).toBe(true);
    }
  });

  it("names the outcome in words a card can show", () => {
    expect(describeEnd({ kind: "out-of-budget", scope: "run", at: 1 })).toBe(
      "out of budget (run)",
    );
    expect(
      describeEnd({ kind: "interrupted", message: "restart", at: 1 }),
    ).toContain("interrupted");
  });
});
