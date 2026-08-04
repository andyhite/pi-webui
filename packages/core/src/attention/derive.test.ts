import { describe, expect, it } from "vitest";

import { humanAuthor } from "../author.js";
import type { NodeId, ObjectId, SessionId, WorkstreamId } from "../ids.js";
import { raiseApproval } from "../sessions/approvals/approval.js";
import { approvalAttention } from "../sessions/approvals/approval.js";
import { destructionAsk } from "../sessions/approvals/ask.js";
import type { ApprovalId } from "../sessions/approvals/ids.js";
import { raiseQuestion } from "../sessions/questions.js";
import { applyTriage, EMPTY_TRIAGE } from "../sessions/triage.js";
import {
  attentionItems,
  deriveAttention,
  type AttentionSources,
} from "./derive.js";
import type { HealthAlert } from "./health.js";
import type { AttentionTarget } from "./types.js";

const target: AttentionTarget = {
  nodeId: "node-1",
  workstreamId: "ws-1",
  sessionId: "sess-1",
};

const question = raiseQuestion({
  id: "q-1",
  sessionId: "sess-1" as SessionId,
  text: "keep going?",
  options: [
    { id: "yes", label: "yes", detail: null },
    { id: "no", label: "no", detail: null },
  ],
  at: 900,
});

const approval = raiseApproval({
  id: "appr-1" as ApprovalId,
  sessionId: "sess-1" as SessionId,
  workstreamId: "ws-1" as WorkstreamId,
  ask: destructionAsk({
    toolName: "object_delete",
    target: { kind: "object", id: "obj-1" },
  }),
  at: 1000,
});

const idleAlert: HealthAlert = {
  alert: "idle",
  id: "health:idle:sess-1",
  target,
  summary: "sess-1 has produced no output for 12 minutes",
  since: 800,
};

function sources(overrides: Partial<AttentionSources> = {}): AttentionSources {
  if (!question.ok) throw new Error("fixture question was refused");
  const attention = approvalAttention(approval);
  if (attention === null) throw new Error("fixture approval was answered");

  return {
    questions: [{ question: question.value, target }],
    approvals: [{ attention, target }],
    drift: [
      {
        flag: {
          consumer: "node-command" as NodeId,
          objectId: "obj-ticket" as ObjectId,
          consumedVersionId: null as never,
          latestVersionId: null,
          cause: "direct",
          via: null,
          originObjectId: "obj-ticket" as ObjectId,
          crossWorkstream: false,
          triage: "active",
          acknowledgementSuperseded: false,
        },
        target: { nodeId: "node-command", workstreamId: "ws-1" },
        changedSummary: "the ticket moved to In Review",
        raisedAt: 700,
      },
    ],
    health: [idleAlert],
    completions: [
      {
        sessionId: "sess-2",
        target: { nodeId: "node-2", workstreamId: "ws-1", sessionId: "sess-2" },
        end: { kind: "completed", at: 600 },
        summary: "sess-2 finished: updated the contributing guide",
      },
    ],
    broadcasts: [
      {
        attention: {
          kind: "session-broadcast",
          broadcastId: "bc-1" as never,
          senderSessionId: "sess-1" as SessionId,
          category: "material-state-changed",
          scope: {
            kind: "everyone-in-workspace",
            workspaceId: "wsp-1" as never,
          },
          recipientCount: 3,
          recipientWorkstreamIds: ["ws-1" as WorkstreamId],
          text: "the migration renamed every column; re-read before you write",
          at: 500,
        },
        target,
      },
    ],
    ...overrides,
  };
}

describe("the attention derivation", () => {
  it("produces one row per feed, ranked with what blocks a session first", () => {
    const derived = deriveAttention(sources(), { now: 2000 });
    expect(attentionItems(derived).map((item) => item.feed)).toEqual([
      "approval",
      "question",
      "health",
      "drift",
      "completion",
      "broadcast",
    ]);
  });

  it("derives every id from the fact behind it, so a re-derivation is stable", () => {
    const first = attentionItems(deriveAttention(sources(), { now: 2000 }));
    const second = attentionItems(deriveAttention(sources(), { now: 3000 }));
    expect(second.map((item) => item.id)).toEqual(first.map((item) => item.id));
    expect(first.map((item) => item.id)).toEqual([
      "approval:appr-1",
      "question:q-1",
      "health:idle:sess-1",
      "drift:node-command:obj-ticket",
      "completion:sess-2",
      "broadcast:bc-1",
    ]);
  });

  it("carries a question's options with their real ids, never labels alone", () => {
    const [item] = attentionItems(
      deriveAttention(
        {
          ...sources(),
          approvals: [],
          health: [],
          completions: [],
          drift: [],
          broadcasts: [],
        },
        { now: 2000 },
      ),
    );
    expect(item?.payload).toEqual({
      kind: "question",
      questionId: "q-1",
      text: "keep going?",
      options: [
        { id: "yes", label: "yes" },
        { id: "no", label: "no" },
      ],
    });
  });

  it("hides a muted item for good — hiding is the source's job", () => {
    const ledger = applyTriage(EMPTY_TRIAGE, "approval:appr-1", "mute", {
      at: 1500,
      by: humanAuthor,
    });
    const items = attentionItems(
      deriveAttention(sources(), { now: 9_000_000, triage: ledger }),
    );
    expect(items.some((item) => item.id === "approval:appr-1")).toBe(false);
  });

  it("hides a snoozed item, then returns it with snoozeUntil back to null", () => {
    const ledger = applyTriage(EMPTY_TRIAGE, "question:q-1", "snooze", {
      at: 1500,
      by: humanAuthor,
      snoozedUntil: 2500,
    });

    const hidden = attentionItems(
      deriveAttention(sources(), { now: 2000, triage: ledger }),
    );
    expect(hidden.some((item) => item.id === "question:q-1")).toBe(false);

    const returned = attentionItems(
      deriveAttention(sources(), { now: 2500, triage: ledger }),
    ).find((item) => item.id === "question:q-1");
    expect(returned?.snoozeUntil).toBeNull();
  });

  it("hides an acknowledged item until its own fact moves, then asks again", () => {
    const ledger = applyTriage(
      EMPTY_TRIAGE,
      "health:idle:sess-1",
      "acknowledge",
      {
        at: 1000,
        by: humanAuthor,
      },
    );

    const acknowledged = attentionItems(
      deriveAttention(sources(), { now: 2000, triage: ledger }),
    );
    expect(acknowledged.some((item) => item.id === "health:idle:sess-1")).toBe(
      false,
    );

    // The session went quiet again *after* the acknowledgement: a new
    // occurrence, and acknowledge is a baseline rather than a permanent
    // dismissal — that is what mute is for (§4.5).
    const again = attentionItems(
      deriveAttention(
        {
          ...sources(),
          health: [{ ...idleAlert, since: 1500 }],
        },
        { now: 2000, triage: ledger },
      ),
    );
    expect(again.some((item) => item.id === "health:idle:sess-1")).toBe(true);
  });

  it("asks again about drift the baseline moved past, whatever the times say", () => {
    const ledger = applyTriage(
      EMPTY_TRIAGE,
      "drift:node-command:obj-ticket",
      "acknowledge",
      { at: 1000, by: humanAuthor, baselineVersionId: "ver-1" as never },
    );

    // Still on the acknowledged version: hidden, which is what acknowledge is.
    const hidden = attentionItems(
      deriveAttention(sources(), { now: 2000, triage: ledger }),
    );
    expect(
      hidden.some((item) => item.id === "drift:node-command:obj-ticket"),
    ).toBe(false);

    // A further version landed, and the drift derivation says so on the flag.
    // The row's own `raisedAt` (700) is *before* the acknowledgement, so the
    // time comparison alone would keep it hidden — the baseline is the fact.
    const base = sources();
    const drifted = attentionItems(
      deriveAttention(
        {
          ...base,
          drift: [
            {
              ...(base.drift[0] as (typeof base.drift)[number]),
              flag: {
                ...(base.drift[0] as (typeof base.drift)[number]).flag,
                triage: "active",
                acknowledgementSuperseded: true,
              },
            },
          ],
        },
        { now: 2000, triage: ledger },
      ),
    );
    expect(
      drifted.some((item) => item.id === "drift:node-command:obj-ticket"),
    ).toBe(true);
  });

  it("ranks an end that wants a decision above drift, and a proven one below", () => {
    const failed = deriveAttention(
      {
        ...sources(),
        completions: [
          {
            sessionId: "sess-3",
            target: { nodeId: "node-3", workstreamId: "ws-1" },
            end: { kind: "failed", at: 650, message: "the build broke" },
            summary: "sess-3 failed: the build broke",
          },
        ],
      },
      { now: 2000 },
    );

    const order = attentionItems(failed).map((item) => item.id);
    expect(order.indexOf("completion:sess-3")).toBeLessThan(
      order.indexOf("drift:node-command:obj-ticket"),
    );
  });

  it("states which route states each row is in, including a failed end", () => {
    const derived = deriveAttention(
      {
        ...sources(),
        completions: [
          {
            sessionId: "sess-3",
            target: { nodeId: "node-3", workstreamId: "ws-1" },
            end: { kind: "failed", at: 650, message: "the build broke" },
            summary: "sess-3 failed: the build broke",
          },
        ],
      },
      { now: 2000 },
    );

    const states = new Map(
      derived.map((entry) => [entry.item.id, entry.states]),
    );
    expect(states.get("approval:appr-1")).toContain("blocked");
    expect(states.get("completion:sess-3")).toContain("failed");
    expect(states.get("completion:sess-3")).toContain("wants-decision");
    expect(states.get("broadcast:bc-1")).toEqual(["anything"]);
  });

  it("keeps a session's broadcast text out of the row it renders", () => {
    const [broadcast] = attentionItems(
      deriveAttention(
        {
          ...sources(),
          questions: [],
          approvals: [],
          drift: [],
          health: [],
          completions: [],
        },
        { now: 2000 },
      ),
    );
    expect(broadcast?.summary).not.toContain("re-read before you write");
    expect(broadcast?.summary).toContain("material-state-changed");
  });
});
