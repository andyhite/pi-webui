import { describe, expect, it } from "vitest";
import type { RuntimeObservation } from "@plotroom/core";
import { planFromObservations } from "./session-plan.js";

describe("the plan as a projection of the observation log (§3.6)", () => {
  it("is empty before anything has been observed", () => {
    expect(planFromObservations([]).phases).toEqual([]);
  });

  it("folds plan-updated observations the same way phase derivation does", () => {
    const observations: readonly RuntimeObservation[] = [
      {
        kind: "plan-updated",
        at: 100,
        phases: [
          {
            name: "Implementation",
            tasks: [{ content: "wire the route", status: "completed" }],
          },
        ],
      },
      // A resumed session's snapshot drops the completed task; the fold
      // carries it forward, same as phases.ts's own reconcilePhases test.
      {
        kind: "plan-updated",
        at: 200,
        phases: [
          {
            name: "Implementation",
            tasks: [{ content: "write the test", status: "in_progress" }],
          },
        ],
      },
    ];

    expect(planFromObservations(observations).phases).toEqual([
      {
        name: "Implementation",
        tasks: [
          { content: "wire the route", status: "completed" },
          { content: "write the test", status: "in_progress" },
        ],
      },
    ]);
  });
});
