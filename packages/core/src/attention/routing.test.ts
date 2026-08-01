import { describe, expect, it } from "vitest";

import {
  decideRouteFires,
  NEW_ROUTE_HEALTH,
  redactForRoute,
  routeMatches,
  ROUTED_SUMMARY_MAX_CHARS,
  type NotificationRoute,
} from "./routing.js";
import type { AttentionState, DerivedAttentionItem } from "./types.js";

function route(
  state: AttentionState,
  overrides: Partial<NotificationRoute> = {},
): NotificationRoute {
  return {
    id: "route-1",
    name: "chat",
    state,
    destination: { kind: "webhook", url: "https://example.invalid/hook" },
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    health: NEW_ROUTE_HEALTH,
    ...overrides,
  };
}

const blockedApproval: DerivedAttentionItem = {
  item: {
    id: "approval:appr-1",
    feed: "approval",
    target: { nodeId: "node-1", workstreamId: "ws-1", sessionId: "sess-1" },
    rank: 0,
    summary: "sess-1 wants to force-push origin/main (irreversible)",
    payload: {
      kind: "approval",
      approvalId: "appr-1",
      capability: "git_force_push",
    },
    raisedAt: 1000,
    snoozeUntil: null,
  },
  states: ["blocked", "wants-decision", "anything"],
};

const finished: DerivedAttentionItem = {
  item: {
    id: "completion:sess-2",
    feed: "completion",
    target: { nodeId: "node-2", workstreamId: "ws-1", sessionId: "sess-2" },
    rank: 600,
    summary: "sess-2 finished",
    payload: { kind: "completion", sessionId: "sess-2" },
    raisedAt: 900,
    snoozeUntil: null,
  },
  states: ["anything"],
};

describe("a route attaches to a state, not to a node", () => {
  it("matches by state, and `anything` matches everything", () => {
    expect(routeMatches(route("blocked"), blockedApproval)).toBe(true);
    expect(routeMatches(route("blocked"), finished)).toBe(false);
    expect(routeMatches(route("anything"), finished)).toBe(true);
  });

  it("never matches while it is disabled", () => {
    expect(
      routeMatches(route("anything", { enabled: false }), blockedApproval),
    ).toBe(false);
  });
});

describe("redaction", () => {
  it("sends the summary and ids, and no payload at all", () => {
    const body = redactForRoute(route("blocked"), blockedApproval);
    expect(body).toEqual({
      routeId: "route-1",
      routeName: "chat",
      state: "blocked",
      itemId: "approval:appr-1",
      feed: "approval",
      summary: "sess-1 wants to force-push origin/main (irreversible)",
      nodeId: "node-1",
      workstreamId: "ws-1",
      sessionId: "sess-1",
      raisedAt: 1000,
      redaction: "summary-only",
    });
    expect(Object.keys(body)).not.toContain("payload");
  });

  it("truncates a summary somebody widened into a content dump", () => {
    const body = redactForRoute(route("anything"), {
      ...finished,
      item: { ...finished.item, summary: "x".repeat(5000) },
    });
    expect(body.summary).toHaveLength(ROUTED_SUMMARY_MAX_CHARS);
  });
});

describe("the edge trigger", () => {
  it("fires once per occurrence and never again while the item stays visible", () => {
    const first = decideRouteFires(
      route("blocked"),
      [blockedApproval],
      new Set(),
    );
    expect(first.fire.map((entry) => entry.item.id)).toEqual([
      "approval:appr-1",
    ]);

    const second = decideRouteFires(
      route("blocked"),
      [blockedApproval],
      first.nextFired,
    );
    expect(second.fire).toEqual([]);
    expect([...second.nextFired]).toEqual(["approval:appr-1"]);
  });

  it("fires again once the item has genuinely left and come back", () => {
    const first = decideRouteFires(
      route("blocked"),
      [blockedApproval],
      new Set(),
    );
    const gone = decideRouteFires(route("blocked"), [], first.nextFired);
    expect(gone.fire).toEqual([]);
    expect([...gone.nextFired]).toEqual([]);

    const returned = decideRouteFires(
      route("blocked"),
      [blockedApproval],
      gone.nextFired,
    );
    expect(returned.fire.map((entry) => entry.item.id)).toEqual([
      "approval:appr-1",
    ]);
  });

  it("does not fire for items the route's state does not match", () => {
    const decision = decideRouteFires(
      route("failed"),
      [blockedApproval, finished],
      new Set(),
    );
    expect(decision.fire).toEqual([]);
  });
});
