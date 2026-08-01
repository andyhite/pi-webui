import { describe, expect, it } from "vitest";

import {
  activityForWorkstream,
  activityTargetExists,
  appendActivityEntry,
  describeActivityTarget,
} from "./what-changed.js";
import type { WorkstreamActivityEntry } from "./what-changed.js";

function entry(
  overrides: Partial<WorkstreamActivityEntry> = {},
): WorkstreamActivityEntry {
  return {
    id: "e1",
    workstreamId: "w1",
    kind: "completion",
    text: "session finished",
    at: 0,
    targetNodeId: "node-1",
    ...overrides,
  };
}

describe("appendActivityEntry", () => {
  it("caps a workstream's history to the newest N entries", () => {
    let history: readonly WorkstreamActivityEntry[] = [];
    for (let i = 0; i < 5; i += 1) {
      history = appendActivityEntry(history, entry({ id: `e${i}`, at: i }), 3);
    }
    expect(history.map((e) => e.id)).toEqual(["e2", "e3", "e4"]);
  });

  it("caps each workstream independently \u2014 one noisy workstream does not crowd out another", () => {
    let history: readonly WorkstreamActivityEntry[] = [];
    for (let i = 0; i < 5; i += 1) {
      history = appendActivityEntry(
        history,
        entry({ id: `w1-${i}`, workstreamId: "w1", at: i }),
        2,
      );
    }
    history = appendActivityEntry(
      history,
      entry({ id: "w2-0", workstreamId: "w2", at: 100 }),
      2,
    );
    expect(activityForWorkstream(history, "w1")).toHaveLength(2);
    expect(activityForWorkstream(history, "w2")).toHaveLength(1);
  });
});

describe("activityTargetExists / describeActivityTarget", () => {
  it("reports a live target plainly", () => {
    const e = entry({ targetNodeId: "node-1" });
    expect(activityTargetExists(e, (id) => id === "node-1")).toBe(true);
    expect(describeActivityTarget(e, (id) => id === "node-1")).toBe("node-1");
  });

  it("tolerates a gone target with an honest tombstone rather than hiding the entry", () => {
    const e = entry({ targetNodeId: "node-deleted" });
    expect(activityTargetExists(e, () => false)).toBe(false);
    expect(describeActivityTarget(e, () => false)).toBe(
      "node-deleted (no longer on the graph)",
    );
  });
});
