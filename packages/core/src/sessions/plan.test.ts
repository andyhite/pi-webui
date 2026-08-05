import { describe, expect, it } from "vitest";

import { planRenderings, renderPlanMarkdown } from "./plan.js";
import type { TodoPhaseSnapshot } from "./runtime.js";

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
