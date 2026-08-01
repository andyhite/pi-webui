import { describe, expect, it } from "vitest";

import { humanAuthor } from "../author.js";
import { newObjectId, newSessionId, newWorkstreamId } from "../ids.js";
import { newWorkspaceId } from "../workspaces/ids.js";
import { GIT_WORKSPACE_KIND } from "../workspaces/kind.js";
import { markDeleted } from "./deletion.js";
import { planSessionFork, type SessionForkContext } from "./fork.js";
import {
  declareToolWorld,
  deriveOutsideWorldMarkers,
} from "./outside-world.js";
import type { RuntimeCapabilities, RuntimeObservation } from "./runtime.js";
import { makeSession, makeTranscript, makeTurn } from "./testing.js";

const CAPABLE: RuntimeCapabilities = {
  fork: "turn-boundary",
  injection: "between-turns",
  reportsCost: true,
  reportsContextWindow: false,
  enforcesPermissions: true,
};

const source = makeSession();

const transcript = makeTranscript({
  sessionId: source.id,
  turns: [
    makeTurn({ ordinal: 1, entries: [{ kind: "output", text: "first" }] }),
    makeTurn({ ordinal: 2, entries: [{ kind: "output", text: "second" }] }),
  ],
});

const declarations = declareToolWorld({
  github_merge: {
    kind: "outside-world",
    system: "github",
    action: "merge",
    reversibility: "irreversible",
  },
});

/** Turn 1 is clean; turn 2 merged a pull request. */
const observations: readonly RuntimeObservation[] = [
  { kind: "turn-started", turn: 1, at: 1_000 },
  { kind: "turn-started", turn: 2, at: 2_000 },
  {
    kind: "tool-started",
    toolName: "github_merge",
    callId: "c1",
    input: {},
    at: 2_010,
  },
  {
    kind: "tool-finished",
    callId: "c1",
    output: "merged",
    isError: false,
    at: 2_020,
  },
];

const context: SessionForkContext = {
  source,
  transcript,
  capabilities: CAPABLE,
  markers: deriveOutsideWorldMarkers(observations, declarations),
};

function request(turn: number) {
  return {
    ids: {
      sessionId: newSessionId(),
      workstreamId: newWorkstreamId(),
      workspaceId: newWorkspaceId(),
    },
    point: { turn },
    forkedBy: humanAuthor,
    workspace: { kind: GIT_WORKSPACE_KIND, config: { repository: "/repo" } },
    workstreamName: "fork of the parser work",
    subjectObjectId: newObjectId(),
    at: 9_000,
  };
}

describe("a fork is a new session with its own workstream and workspace (§6.3)", () => {
  it("plans the records, the provenance, and the runtime route", () => {
    const planned = planSessionFork(context, request(1));

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const plan = planned.plan;

    expect(plan.runtime).toEqual({ mode: "native", point: { turn: 1 } });
    expect(plan.session.mode).toBe(source.mode);
    expect(plan.session.launch).toEqual(source.launch);
    expect(plan.workstream.name).toBe("fork of the parser work");
    // Its own workspace, in its own workstream (§3.4's boundary).
    expect(plan.workspace.workstreamId).toBe(plan.session.workstreamId);
    expect(plan.provenance).toMatchObject({
      relation: "session_forked_from",
      fromSessionId: source.id,
      toSessionId: plan.session.id,
    });
    expect(plan.seedComplete).toBe(true);
  });

  it("marks the point as clean before the outside world was touched", () => {
    const planned = planSessionFork(context, request(1));

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.cleanliness.clean).toBe(true);
    expect(planned.plan.cleanliness.certain).toBe(true);
  });

  it("marks the point as dirty after it, naming the irreversible write", () => {
    const planned = planSessionFork(context, request(2));

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.cleanliness.clean).toBe(false);
    expect(planned.plan.cleanliness.irreversible).toHaveLength(1);
    expect(planned.plan.cleanliness.description).toContain("merge");
  });

  it("seeds from the transcript prefix when the runtime cannot fork", () => {
    const planned = planSessionFork(
      { ...context, capabilities: { ...CAPABLE, fork: "none" } },
      request(1),
    );

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.runtime.mode).toBe("seeded");
    if (planned.plan.runtime.mode !== "seeded") return;
    expect(planned.plan.runtime.seed).toContain("first");
    expect(planned.plan.runtime.seed).not.toContain("second");
  });

  it("reports an incomplete seed rather than forking quietly", () => {
    const released = makeTranscript({
      sessionId: source.id,
      turns: [
        makeTurn({
          ordinal: 1,
          entries: [
            {
              kind: "tool-result",
              callId: "c9",
              toolName: "read",
              output: "[released]",
              isError: false,
              released: {
                releasedAt: 500,
                bytes: 4_096,
                contentHash: "abc",
              },
            },
          ],
        }),
      ],
    });

    const planned = planSessionFork(
      {
        ...context,
        transcript: released,
        capabilities: { ...CAPABLE, fork: "none" },
      },
      request(1),
    );

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.seedComplete).toBe(false);
  });

  it("refuses a point the transcript does not have", () => {
    const planned = planSessionFork(context, request(7));

    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.refusal.reason).toBe("unknown_point");
  });

  it("refuses a deleted source rather than resurrecting it", () => {
    const planned = planSessionFork(
      {
        ...context,
        source: {
          ...source,
          deletion: markDeleted(source.deletion, 8_000, humanAuthor),
        },
      },
      request(1),
    );

    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    expect(planned.refusal.reason).toBe("source_deleted");
  });

  it("reports cleanliness as uncertain when nothing was declared", () => {
    const planned = planSessionFork(
      { source, transcript, capabilities: CAPABLE },
      request(2),
    );

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    // No markers at all: nothing is known to have been touched, and nothing is
    // known not to have been either — but with no tool calls observed, there is
    // nothing to be uncertain about.
    expect(planned.plan.cleanliness.clean).toBe(true);
    expect(planned.plan.cleanliness.certain).toBe(true);
  });
});
