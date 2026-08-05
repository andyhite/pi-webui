import { describe, expect, it } from "vitest";

import {
  blockedTasksSince,
  planRenderings,
  renderPlanMarkdown,
} from "./plan.js";
import type { RuntimeObservation, TodoPhaseSnapshot } from "./runtime.js";

describe("the plan as content (§3.1, §3.6)", () => {
  it("renders an empty plan honestly, not as an empty list", () => {
    expect(renderPlanMarkdown([])).toBe("_No plan yet._");
  });

  it("renders one heading per phase, with a task list beneath it", () => {
    const phases: readonly TodoPhaseSnapshot[] = [
      {
        name: "Implementation",
        tasks: [
          { content: "wire the route", status: "completed" },
          { content: "write the test", status: "in_progress" },
          { content: "ship it", status: "pending" },
        ],
      },
    ];

    const markdown = renderPlanMarkdown(phases);
    expect(markdown).toContain("## Implementation");
    expect(markdown).toContain("- [x] wire the route");
    expect(markdown).toContain("- [ ] write the test *(in progress)*");
    expect(markdown).toContain("- [ ] ship it");
  });

  it("names a phase with no tasks rather than rendering an empty heading", () => {
    const markdown = renderPlanMarkdown([{ name: "Planning", tasks: [] }]);
    expect(markdown).toContain("## Planning");
    expect(markdown).toContain("_No tasks._");
  });

  it("names a blocker, or says it has none", () => {
    const blocked = renderPlanMarkdown([
      {
        name: "Implementation",
        tasks: [
          {
            content: "ship it",
            status: "blocked",
            blocker: "waiting on review",
          },
        ],
      },
    ]);
    expect(blocked).toContain("*(blocked: waiting on review)*");

    const unspecified = renderPlanMarkdown([
      {
        name: "Implementation",
        tasks: [{ content: "ship it", status: "blocked" }],
      },
    ]);
    expect(unspecified).toContain("*(blocked: unspecified)*");
  });

  it("renders three ways, like every other object, and counts tasks honestly", () => {
    const phases: readonly TodoPhaseSnapshot[] = [
      {
        name: "Implementation",
        tasks: [
          { content: "wire the route", status: "completed" },
          { content: "write the test", status: "pending" },
        ],
      },
    ];

    const renderings = planRenderings(phases);
    expect(renderings.card).toEqual({ phases: 1, tasks: 2, completed: 1 });
    expect(renderings.summary).toBe("plan · 1/2 done");
    expect(renderings.agentContent).toBe(renderPlanMarkdown(phases));
  });

  it("says a plan has no tasks yet rather than a division by zero", () => {
    expect(planRenderings([]).summary).toBe("plan · no tasks yet");
    expect(planRenderings([{ name: "Planning", tasks: [] }]).summary).toBe(
      "plan · no tasks yet",
    );
  });
});

describe("blocked tasks, with the moment the block began (§7.2, #155)", () => {
  it("names nothing when nothing is blocked", () => {
    expect(blockedTasksSince([])).toEqual([]);
  });

  it("dates the block from the first observation that reported it, not the latest", () => {
    const observations: readonly RuntimeObservation[] = [
      {
        kind: "plan-updated",
        at: 100,
        phases: [
          {
            name: "Implementation",
            tasks: [
              {
                content: "ship it",
                status: "blocked",
                blocker: "waiting on review",
              },
            ],
          },
        ],
      },
      {
        kind: "plan-updated",
        at: 200,
        phases: [
          {
            name: "Implementation",
            tasks: [
              {
                content: "ship it",
                status: "blocked",
                blocker: "waiting on review",
              },
            ],
          },
        ],
      },
    ];

    expect(blockedTasksSince(observations)).toEqual([
      {
        phaseName: "Implementation",
        content: "ship it",
        blocker: "waiting on review",
        since: 100,
      },
    ]);
  });

  it("starts a fresh since once unblocked and blocked again", () => {
    const observations: readonly RuntimeObservation[] = [
      {
        kind: "plan-updated",
        at: 100,
        phases: [
          {
            name: "Implementation",
            tasks: [{ content: "ship it", status: "blocked" }],
          },
        ],
      },
      {
        kind: "plan-updated",
        at: 150,
        phases: [
          {
            name: "Implementation",
            tasks: [{ content: "ship it", status: "in_progress" }],
          },
        ],
      },
      {
        kind: "plan-updated",
        at: 300,
        phases: [
          {
            name: "Implementation",
            tasks: [
              { content: "ship it", status: "blocked", blocker: "flaky CI" },
            ],
          },
        ],
      },
    ];

    expect(blockedTasksSince(observations)).toEqual([
      {
        phaseName: "Implementation",
        content: "ship it",
        blocker: "flaky CI",
        since: 300,
      },
    ]);
  });

  it("updates the blocker without resetting since when re-blocked without an intervening unblock", () => {
    const observations: readonly RuntimeObservation[] = [
      {
        kind: "plan-updated",
        at: 100,
        phases: [
          {
            name: "Implementation",
            tasks: [
              { content: "ship it", status: "blocked", blocker: "flaky CI" },
            ],
          },
        ],
      },
      {
        kind: "plan-updated",
        at: 200,
        phases: [
          {
            name: "Implementation",
            tasks: [
              {
                content: "ship it",
                status: "blocked",
                blocker: "waiting on review",
              },
            ],
          },
        ],
      },
    ];

    expect(blockedTasksSince(observations)).toEqual([
      {
        phaseName: "Implementation",
        content: "ship it",
        blocker: "waiting on review",
        since: 100,
      },
    ]);
  });

  it("clears the block when a later snapshot drops the task entirely, not only when it changes status", () => {
    const observations: readonly RuntimeObservation[] = [
      {
        kind: "plan-updated",
        at: 100,
        phases: [
          {
            name: "Implementation",
            tasks: [{ content: "ship it", status: "blocked" }],
          },
        ],
      },
      {
        kind: "plan-updated",
        at: 200,
        phases: [{ name: "Implementation", tasks: [] }],
      },
    ];

    expect(blockedTasksSince(observations)).toEqual([]);
  });

  it("names an unspecified blocker rather than a blank one", () => {
    const observations: readonly RuntimeObservation[] = [
      {
        kind: "plan-updated",
        at: 100,
        phases: [
          {
            name: "Implementation",
            tasks: [{ content: "ship it", status: "blocked" }],
          },
        ],
      },
    ];

    expect(blockedTasksSince(observations)[0]?.blocker).toBe("unspecified");
  });

  it("says nothing once completed, even though the last blocked snapshot said something", () => {
    const observations: readonly RuntimeObservation[] = [
      {
        kind: "plan-updated",
        at: 100,
        phases: [
          {
            name: "Implementation",
            tasks: [{ content: "ship it", status: "blocked" }],
          },
        ],
      },
      {
        kind: "plan-updated",
        at: 200,
        phases: [
          {
            name: "Implementation",
            tasks: [{ content: "ship it", status: "completed" }],
          },
        ],
      },
    ];

    expect(blockedTasksSince(observations)).toEqual([]);
  });
});
