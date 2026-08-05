import { describe, expect, it } from "vitest";

import {
  DEFAULT_HEALTH_THRESHOLDS,
  deriveHealthAlerts,
  pathsOverlap,
  type HealthObservations,
  type HealthSessionObservation,
} from "./health.js";

const NOW = 100_000;

function session(
  overrides: Partial<HealthSessionObservation> = {},
): HealthSessionObservation {
  return {
    sessionId: "sess-1",
    workstreamId: "ws-1",
    nodeId: "node-1",
    live: true,
    startedAt: NOW - 60,
    lastOutputAt: NOW - 10,
    lastWorkspaceChangeAt: NOW - 10,
    costSinceWorkspaceChangeMicros: 0,
    blockedOnHumanSince: null,
    blockedOnHumanReason: null,
    ...overrides,
  };
}

function observations(
  overrides: Partial<HealthObservations> = {},
): HealthObservations {
  return {
    now: NOW,
    sessions: [],
    pendingAsks: [],
    claimWaits: [],
    workstreams: [],
    ...overrides,
  };
}

describe("idle", () => {
  it("alerts on a live session that has produced no output past the threshold", () => {
    const alerts = deriveHealthAlerts(
      observations({
        sessions: [
          session({
            lastOutputAt: NOW - DEFAULT_HEALTH_THRESHOLDS.idleSeconds - 1,
          }),
        ],
      }),
    );
    expect(alerts.map((alert) => alert.alert)).toEqual(["idle"]);
    expect(alerts[0]?.id).toBe("health:idle:sess-1");
  });

  it("says nothing about a session that has ended — finished is not idle", () => {
    const alerts = deriveHealthAlerts(
      observations({
        sessions: [
          session({
            live: false,
            lastOutputAt: NOW - 100_000,
            lastWorkspaceChangeAt: NOW - 100_000,
          }),
        ],
      }),
    );
    expect(alerts).toEqual([]);
  });
});

describe("spinning", () => {
  it("needs both halves: cost climbing AND an unchanged workspace", () => {
    const quietAndCheap = deriveHealthAlerts(
      observations({
        sessions: [
          session({
            lastWorkspaceChangeAt: NOW - 10_000,
            costSinceWorkspaceChangeMicros: 10,
          }),
        ],
      }),
    );
    expect(quietAndCheap.map((alert) => alert.alert)).not.toContain("spinning");

    const busyAndRecent = deriveHealthAlerts(
      observations({
        sessions: [
          session({
            lastWorkspaceChangeAt: NOW - 5,
            costSinceWorkspaceChangeMicros: 5_000_000,
          }),
        ],
      }),
    );
    expect(busyAndRecent.map((alert) => alert.alert)).not.toContain("spinning");

    const spinning = deriveHealthAlerts(
      observations({
        sessions: [
          session({
            lastOutputAt: NOW,
            lastWorkspaceChangeAt: NOW - 10_000,
            costSinceWorkspaceChangeMicros: 5_000_000,
          }),
        ],
      }),
    );
    expect(spinning.map((alert) => alert.alert)).toEqual(["spinning"]);
    expect(spinning[0]?.summary).toContain("$5.00");
  });

  it("measures a session that never wrote anything from when it started", () => {
    const alerts = deriveHealthAlerts(
      observations({
        sessions: [
          session({
            lastOutputAt: NOW,
            startedAt: NOW - 10_000,
            lastWorkspaceChangeAt: null,
            costSinceWorkspaceChangeMicros: 5_000_000,
          }),
        ],
      }),
    );
    expect(alerts.map((alert) => alert.alert)).toEqual(["spinning"]);
  });
});

describe("conflict predicted", () => {
  it("names two active workstreams writing the same path in one repository", () => {
    const alerts = deriveHealthAlerts(
      observations({
        workstreams: [
          {
            workstreamId: "ws-b",
            nodeId: "node-b",
            repositoryId: "repo-1",
            active: true,
            writtenPaths: ["src/auth.ts", "docs/readme.md"],
          },
          {
            workstreamId: "ws-a",
            nodeId: "node-a",
            repositoryId: "repo-1",
            active: true,
            writtenPaths: ["src/auth.ts"],
          },
        ],
      }),
    );
    expect(alerts).toHaveLength(1);
    // Sorted, so the pair has one id whichever order they were read in.
    expect(alerts[0]?.id).toBe("health:conflict-predicted:ws-a:ws-b");
    expect(alerts[0]?.summary).toContain("src/auth.ts");
  });

  it("says nothing about two workstreams in different repositories", () => {
    const alerts = deriveHealthAlerts(
      observations({
        workstreams: [
          {
            workstreamId: "ws-a",
            nodeId: "node-a",
            repositoryId: "repo-1",
            active: true,
            writtenPaths: ["src/auth.ts"],
          },
          {
            workstreamId: "ws-b",
            nodeId: "node-b",
            repositoryId: "repo-2",
            active: true,
            writtenPaths: ["src/auth.ts"],
          },
        ],
      }),
    );
    expect(alerts).toEqual([]);
  });

  it("says nothing about a workstream with nothing running", () => {
    const alerts = deriveHealthAlerts(
      observations({
        workstreams: [
          {
            workstreamId: "ws-a",
            nodeId: "node-a",
            repositoryId: "repo-1",
            active: true,
            writtenPaths: ["src/auth.ts"],
          },
          {
            workstreamId: "ws-b",
            nodeId: "node-b",
            repositoryId: "repo-1",
            active: false,
            writtenPaths: ["src/auth.ts"],
          },
        ],
      }),
    );
    expect(alerts).toEqual([]);
  });

  it("alerts on overlapping waitlisted claims inside one workstream", () => {
    const alerts = deriveHealthAlerts(
      observations({
        claimWaits: [
          {
            waitId: "wait-1",
            sessionId: "sess-1",
            workstreamId: "ws-1",
            nodeId: "node-1",
            path: "src",
            since: NOW - 10,
            blockedOnHuman: false,
          },
          {
            waitId: "wait-2",
            sessionId: "sess-2",
            workstreamId: "ws-1",
            nodeId: "node-2",
            path: "src/auth.ts",
            since: NOW - 10,
            blockedOnHuman: false,
          },
        ],
      }),
    );
    expect(alerts.map((alert) => alert.alert)).toEqual(["conflict-predicted"]);
    expect(alerts[0]?.id).toBe(
      "health:conflict-predicted:ws-1:waitlist:wait-1:wait-2",
    );
  });
});

describe("unanswered", () => {
  it("alerts on a question or approval past the threshold, and not before", () => {
    const fresh = deriveHealthAlerts(
      observations({
        pendingAsks: [
          {
            kind: "question",
            id: "q-1",
            target: { nodeId: "node-1", workstreamId: "ws-1" },
            raisedAt: NOW - 10,
            summary: "keep going?",
          },
        ],
      }),
    );
    expect(fresh).toEqual([]);

    const stale = deriveHealthAlerts(
      observations({
        pendingAsks: [
          {
            kind: "approval",
            id: "appr-1",
            target: { nodeId: "node-1", workstreamId: "ws-1" },
            raisedAt: NOW - DEFAULT_HEALTH_THRESHOLDS.unansweredSeconds,
            summary: "force-push origin/main",
          },
        ],
      }),
    );
    expect(stale.map((alert) => alert.id)).toEqual([
      "health:unanswered:approval:appr-1",
    ]);
  });
});

describe("blocked on you", () => {
  it("counts only the time a session spent waiting on a human", () => {
    const working = deriveHealthAlerts(
      observations({
        sessions: [session({ lastOutputAt: NOW, blockedOnHumanSince: null })],
      }),
    );
    expect(working).toEqual([]);

    const waiting = deriveHealthAlerts(
      observations({
        sessions: [
          session({
            lastOutputAt: NOW,
            blockedOnHumanSince:
              NOW - DEFAULT_HEALTH_THRESHOLDS.blockedOnHumanSeconds,
            blockedOnHumanReason: "an approval nobody answered",
          }),
        ],
      }),
    );
    expect(waiting.map((alert) => alert.id)).toEqual([
      "health:blocked-on-you:sess-1",
    ]);
  });

  it("alerts on a claim wait on its own, with its own threshold", () => {
    const alerts = deriveHealthAlerts(
      observations({
        thresholds: { ...DEFAULT_HEALTH_THRESHOLDS, claimWaitSeconds: 30 },
        claimWaits: [
          {
            waitId: "wait-1",
            sessionId: "sess-9",
            workstreamId: "ws-1",
            nodeId: "node-9",
            path: "src/auth.ts",
            since: NOW - 31,
            blockedOnHuman: true,
          },
        ],
      }),
    );
    expect(alerts.map((alert) => alert.id)).toEqual([
      "health:blocked-on-you:claim:wait-1",
    ]);
    expect(alerts[0]?.summary).toContain("only you can grant");
  });
});

describe("integration broken", () => {
  it("alerts immediately on a broken connection, with no threshold to wait out", () => {
    const alerts = deriveHealthAlerts(
      observations({
        integrations: [
          {
            integrationId: "integration-1",
            name: "Fake GitHub",
            system: "github",
            target: { nodeId: "node-1", workstreamId: null },
            since: NOW,
            reason: "authentication failed",
          },
        ],
      }),
    );
    expect(alerts.map((alert) => alert.id)).toEqual([
      "health:integration-broken:integration-1",
    ]);
    expect(alerts[0]?.summary).toContain("authentication failed");
    expect(alerts[0]?.since).toBe(NOW);
  });

  it("reports nothing when no integration is broken", () => {
    expect(deriveHealthAlerts(observations({ integrations: [] }))).toEqual([]);
    expect(deriveHealthAlerts(observations({}))).toEqual([]);
  });
});

describe("plan blocked", () => {
  it("alerts immediately on a blocked task, with no threshold to wait out", () => {
    const alerts = deriveHealthAlerts(
      observations({
        planBlocks: [
          {
            sessionId: "sess-1",
            target: { nodeId: "node-1", workstreamId: "ws-1" },
            since: NOW - 500,
            phaseName: "Implementation",
            taskContent: "ship it",
            blocker: "waiting on review",
          },
        ],
      }),
    );
    expect(alerts.map((alert) => alert.alert)).toEqual(["plan-blocked"]);
    expect(alerts[0]?.id).toBe(
      "health:plan-blocked:sess-1:Implementation:ship it",
    );
    expect(alerts[0]?.summary).toBe("ship it: waiting on review");
    expect(alerts[0]?.since).toBe(NOW - 500);
  });

  it("keeps two sessions' identically-named tasks as two rows, not one", () => {
    const alerts = deriveHealthAlerts(
      observations({
        planBlocks: [
          {
            sessionId: "sess-1",
            target: { nodeId: "node-1", workstreamId: "ws-1" },
            since: NOW,
            phaseName: "Implementation",
            taskContent: "ship it",
            blocker: "flaky CI",
          },
          {
            sessionId: "sess-2",
            target: { nodeId: "node-2", workstreamId: "ws-2" },
            since: NOW,
            phaseName: "Implementation",
            taskContent: "ship it",
            blocker: "waiting on review",
          },
        ],
      }),
    );
    expect(alerts.map((alert) => alert.id)).toEqual([
      "health:plan-blocked:sess-1:Implementation:ship it",
      "health:plan-blocked:sess-2:Implementation:ship it",
    ]);
  });

  it("keeps two phases' identically-named tasks in one session as two rows too", () => {
    const alerts = deriveHealthAlerts(
      observations({
        planBlocks: [
          {
            sessionId: "sess-1",
            target: { nodeId: "node-1", workstreamId: "ws-1" },
            since: NOW,
            phaseName: "Planning",
            taskContent: "review",
            blocker: "waiting on the spec",
          },
          {
            sessionId: "sess-1",
            target: { nodeId: "node-1", workstreamId: "ws-1" },
            since: NOW,
            phaseName: "Implementation",
            taskContent: "review",
            blocker: "waiting on the PR",
          },
        ],
      }),
    );
    expect(alerts.map((alert) => alert.id)).toEqual([
      "health:plan-blocked:sess-1:Planning:review",
      "health:plan-blocked:sess-1:Implementation:review",
    ]);
  });

  it("reports nothing when nothing is blocked", () => {
    expect(deriveHealthAlerts(observations({ planBlocks: [] }))).toEqual([]);
    expect(deriveHealthAlerts(observations({}))).toEqual([]);
  });
});

describe("path overlap", () => {
  it("is the claim vocabulary: the same path, or one inside the other", () => {
    expect(pathsOverlap("src/a.ts", "src/a.ts")).toBe(true);
    expect(pathsOverlap("src", "src/a.ts")).toBe(true);
    expect(pathsOverlap("src/a.ts", "src")).toBe(true);
    expect(pathsOverlap("src/a.ts", "src/b.ts")).toBe(false);
    expect(pathsOverlap("src", "srcs/a.ts")).toBe(false);
  });
});
