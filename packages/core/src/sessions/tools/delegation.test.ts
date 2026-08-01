import { describe, expect, it } from "vitest";

import { humanAuthor, sessionAuthor } from "../../author.js";
import type { CommandId, SessionId, WorkstreamId } from "../../ids.js";
import type { LineageIndex } from "../../lineage.js";
import {
  attributeSpend,
  attributedTotal,
  attributionChainFor,
  budgetTapFor,
  planDelegation,
} from "./delegation.js";

/**
 * §3.6: "Every delegated or dispatched session is visible on the graph with its
 * provenance, never hidden inside a tool call; its spend counts against every
 * budget that binds the initiating work" (principle 2).
 */

const ROOT = "sess_root" as SessionId;
const CHILD = "sess_child" as SessionId;
const GRANDCHILD = "sess_grandchild" as SessionId;
const WS = "ws_1" as WorkstreamId;
const CMD = "cmd_1" as CommandId;

const lineage: LineageIndex = {
  parentOf: (session) => {
    if (session === CHILD) return ROOT;
    return null;
  },
};

describe("planDelegation", () => {
  const plan = planDelegation(lineage, {
    parentSessionId: CHILD,
    childSessionId: GRANDCHILD,
    workstreamId: WS,
    commandId: CMD,
    reason: "split the migration out",
    at: 1_700_000_000,
  });

  it("records the child's lineage, so its chain still ends at a human gesture", () => {
    expect(plan.lineage).toEqual({ sessionId: GRANDCHILD, initiatedBy: CHILD });
  });

  it("records provenance with meaning, never hiding the session in a tool call", () => {
    expect(plan.provenance).toEqual({
      relation: "session_delegated",
      fromSessionId: CHILD,
      toSessionId: GRANDCHILD,
      recordedAt: 1_700_000_000,
    });
    expect(plan.reason).toBe("split the migration out");
  });

  it("attributes up the whole initiating chain, including the not-yet-persisted child", () => {
    expect(plan.attributionChain).toEqual([GRANDCHILD, CHILD, ROOT]);
  });
});

describe("attributionChainFor", () => {
  it("is the session itself plus every ancestor", () => {
    expect(attributionChainFor(lineage, CHILD)).toEqual([CHILD, ROOT]);
    expect(attributionChainFor(lineage, ROOT)).toEqual([ROOT]);
  });

  it("survives a cyclic index without looping forever", () => {
    const cyclic: LineageIndex = {
      parentOf: (session) => (session === ROOT ? CHILD : ROOT),
    };
    expect(attributionChainFor(cyclic, ROOT)).toEqual([ROOT, CHILD]);
  });
});

describe("attributeSpend", () => {
  const spend = {
    sessionId: GRANDCHILD,
    amountUsd: 0.42,
    basis: "reported" as const,
    at: 1_700_000_100,
  };
  const entries = attributeSpend([GRANDCHILD, CHILD, ROOT], spend);

  it("charges the spender as its own and every ancestor as a descendant's", () => {
    expect(entries).toHaveLength(3);
    expect(entries[0]?.basis).toBe("own");
    expect(
      entries.slice(1).every((entry) => entry.basis === "descendant"),
    ).toBe(true);
    expect(entries.every((entry) => entry.sourceSessionId === GRANDCHILD)).toBe(
      true,
    );
  });

  it("keeps the cost basis, so a total never claims to be reported when it was priced", () => {
    expect(entries.every((entry) => entry.costBasis === "reported")).toBe(true);
  });

  it("totals per session, own work and delegates alike", () => {
    const own = attributeSpend([CHILD, ROOT], {
      sessionId: CHILD,
      amountUsd: 1,
      basis: "priced",
      at: 1_700_000_200,
    });
    const ledger = [...entries, ...own];

    expect(attributedTotal(ledger, GRANDCHILD)).toBeCloseTo(0.42);
    expect(attributedTotal(ledger, CHILD)).toBeCloseTo(1.42);
    expect(attributedTotal(ledger, ROOT)).toBeCloseTo(1.42);
  });
});

describe("budgetTapFor", () => {
  it("names the scopes and everyone charged, for Phase 6 to enforce against", () => {
    const plan = planDelegation(lineage, {
      parentSessionId: CHILD,
      childSessionId: GRANDCHILD,
      workstreamId: WS,
      commandId: CMD,
      reason: null,
      at: 1,
    });
    const tap = budgetTapFor(plan, sessionAuthor(CHILD));
    expect(tap.scopes).toEqual(["run", "workstream", "global"]);
    expect(tap.chargedTo).toEqual([GRANDCHILD, CHILD, ROOT]);
    expect(tap.initiatedBy).toEqual(sessionAuthor(CHILD));

    const byHuman = budgetTapFor(plan, humanAuthor);
    expect(byHuman.initiatedBy).toEqual(humanAuthor);
  });
});
