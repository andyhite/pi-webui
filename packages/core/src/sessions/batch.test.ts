import { describe, expect, it } from "vitest";

import { humanAuthor, sessionAuthor } from "../author.js";
import { newSessionId, newWorkstreamId } from "../ids.js";
import type { LineageIndex } from "../lineage.js";
import {
  batchMemberKey,
  planBatch,
  presetPrompt,
  type BatchContext,
} from "./batch.js";
import type { StopCandidate } from "./stop.js";

const workstream = newWorkstreamId();

const caller = newSessionId();
const child = newSessionId();
const peerA = newSessionId();
const peerB = newSessionId();
const finished = newSessionId();
const unknown = newSessionId();

function candidate(
  sessionId: ReturnType<typeof newSessionId>,
  running = true,
): StopCandidate {
  return { sessionId, workstreamId: workstream, running };
}

const context: BatchContext = {
  candidates: [
    candidate(caller),
    candidate(child),
    candidate(peerA),
    candidate(peerB),
    candidate(finished, false),
  ],
  lineage: { parentOf: (session) => (session === child ? caller : null) },
};

describe("one gesture, one batch (§4.2, principle 9)", () => {
  it("derives every member's idempotency key from the batch key", () => {
    const planned = planBatch(context, {
      batchKey: "batch-7",
      kind: "inject",
      requestedBy: humanAuthor,
      sessionIds: [peerA, peerB],
      prompt: "the answer is in docs/architecture.md",
      at: 1_000,
    });

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.members).toEqual([
      { sessionId: peerA, memberKey: batchMemberKey("batch-7", peerA) },
      { sessionId: peerB, memberKey: batchMemberKey("batch-7", peerB) },
    ]);
    expect(planned.plan.prompt).toBe("the answer is in docs/architecture.md");
  });

  it("replays to the same plan, so a half-failed batch is retryable", () => {
    const request = {
      batchKey: "batch-7",
      kind: "stop" as const,
      requestedBy: humanAuthor,
      sessionIds: [peerA, peerB],
      at: 1_000,
    };

    expect(planBatch(context, request)).toEqual(planBatch(context, request));
  });

  it("refuses one-prompt-to-many with no prompt", () => {
    const planned = planBatch(context, {
      batchKey: "batch-8",
      kind: "inject",
      requestedBy: humanAuthor,
      sessionIds: [peerA],
      prompt: "   ",
      at: 1_000,
    });

    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.refusal.reason).toBe("prompt_required");
  });
});

describe("a batch is partial by design, and says why", () => {
  it("skips ended sessions for the gestures that need a live one", () => {
    const planned = planBatch(context, {
      batchKey: "batch-9",
      kind: "stop",
      requestedBy: humanAuthor,
      sessionIds: [peerA, finished],
      at: 1_000,
    });

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.members.map((member) => member.sessionId)).toEqual([
      peerA,
    ]);
    expect(planned.plan.skipped).toEqual([
      {
        sessionId: finished,
        reason: "not_running",
        message: "stop needs a live session; this one has ended",
      },
    ]);
  });

  it("skips running sessions when archiving", () => {
    const planned = planBatch(context, {
      batchKey: "batch-10",
      kind: "archive",
      requestedBy: humanAuthor,
      sessionIds: [peerA, finished],
      at: 1_000,
    });

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.members.map((member) => member.sessionId)).toEqual([
      finished,
    ]);
    expect(planned.plan.skipped[0]?.reason).toBe("still_running");
  });

  it("names an unknown session rather than silently dropping it", () => {
    const planned = planBatch(context, {
      batchKey: "batch-11",
      kind: "close",
      requestedBy: humanAuthor,
      sessionIds: [unknown],
      at: 1_000,
    });

    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.refusal.reason).toBe("nothing_to_do");
    expect(planned.refusal.skipped[0]?.reason).toBe("not_found");
  });

  it("collapses a session named twice", () => {
    const planned = planBatch(context, {
      batchKey: "batch-12",
      kind: "stop",
      requestedBy: humanAuthor,
      sessionIds: [peerA, peerA],
      at: 1_000,
    });

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.members).toHaveLength(1);
    expect(planned.plan.skipped[0]?.reason).toBe("duplicate");
  });
});

describe("the lineage rule applies to the authoring batch only (principle 1)", () => {
  it("skips the caller's own chain and keeps the peers, when prompting", () => {
    const planned = planBatch(context, {
      batchKey: "batch-13",
      kind: "inject",
      requestedBy: sessionAuthor(caller),
      sessionIds: [peerA, child, caller],
      prompt: "look at the failing test first",
      at: 1_000,
    });

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.members.map((member) => member.sessionId)).toEqual([
      peerA,
    ]);
    expect(planned.plan.skipped.map((skip) => skip.reason)).toEqual([
      "own_chain",
      "own_chain",
    ]);
  });

  it("leaves a human unconstrained", () => {
    const planned = planBatch(context, {
      batchKey: "batch-14",
      kind: "inject",
      requestedBy: humanAuthor,
      sessionIds: [caller, child, peerA],
      prompt: "wrap up",
      at: 1_000,
    });

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.members).toHaveLength(3);
  });

  it("refuses an injecting batch whose every member was in the caller's chain", () => {
    const lineage: LineageIndex = {
      parentOf: (session) => (session === child ? caller : null),
    };
    const planned = planBatch(
      { candidates: context.candidates, lineage },
      {
        batchKey: "batch-15",
        kind: "inject",
        requestedBy: sessionAuthor(caller),
        sessionIds: [child],
        prompt: "try the other branch",
        at: 1_000,
      },
    );

    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.refusal.reason).toBe("nothing_to_do");
    expect(planned.refusal.skipped[0]?.reason).toBe("own_chain");
  });

  it("lets a parent batch-stop or batch-close its own runaway child", () => {
    // Principle 1 is about authoring intent; stopping takes capability away. A
    // parent that cannot stop the children it started is a batch stop nobody can
    // use — and §4.1's rule (no running, resuming, or re-running inside your own
    // chain) is a different rule, which none of these kinds is.
    for (const kind of ["stop", "close"] as const) {
      const planned = planBatch(context, {
        batchKey: `batch-16-${kind}`,
        kind,
        requestedBy: sessionAuthor(caller),
        sessionIds: [child, peerA],
        at: 1_000,
      });

      expect(planned.ok).toBe(true);
      if (!planned.ok) return;
      expect(planned.plan.members.map((member) => member.sessionId)).toEqual([
        child,
        peerA,
      ]);
      expect(planned.plan.skipped).toEqual([]);
    }
  });

  it("lets a session archive an ended member of its own chain", () => {
    const endedChild = newSessionId();
    const planned = planBatch(
      {
        candidates: [
          ...context.candidates,
          { sessionId: endedChild, workstreamId: workstream, running: false },
        ],
        lineage: {
          parentOf: (session) => (session === endedChild ? caller : null),
        },
      },
      {
        batchKey: "batch-17",
        kind: "archive",
        requestedBy: sessionAuthor(caller),
        sessionIds: [endedChild],
        at: 1_000,
      },
    );

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.members).toHaveLength(1);
  });

  it("still refuses a session prompting into its own chain, one kind apart", () => {
    // The two answers side by side, same caller and same member: the narrowing is
    // scoped to what the gesture does, not to who asked for it.
    const stopped = planBatch(context, {
      batchKey: "batch-18a",
      kind: "stop",
      requestedBy: sessionAuthor(caller),
      sessionIds: [child],
      at: 1_000,
    });
    const prompted = planBatch(context, {
      batchKey: "batch-18b",
      kind: "inject",
      requestedBy: sessionAuthor(caller),
      sessionIds: [child],
      prompt: "stop what you are doing",
      at: 1_000,
    });

    expect(stopped.ok).toBe(true);
    expect(prompted.ok).toBe(false);
  });
});

describe("preset prompts are configured content (§4.2)", () => {
  it("resolves by id, and answers null for one that was removed", () => {
    const presets = [
      { id: "wrap-up", label: "Wrap up", text: "wrap up and report" },
    ];

    expect(presetPrompt(presets, "wrap-up")?.text).toBe("wrap up and report");
    expect(presetPrompt(presets, "gone")).toBeNull();
  });
});
