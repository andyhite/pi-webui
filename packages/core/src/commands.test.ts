import { describe, expect, it } from "vitest";
import {
  checkContentBudget,
  checkOutputCrossing,
  checkPublish,
  checkSubmission,
  confirmParameter,
  effectOfDeletingProducer,
  effectiveAskPoints,
  outputBindState,
  resolveParameters,
  type CommandOutput,
  type CommandParameter,
  type ContentBudget,
  type ExpectedOutcome,
  type ParameterBinding,
} from "./commands.js";
import type {
  CommandId,
  ObjectId,
  OutputId,
  RunId,
  WorkstreamId,
} from "./ids.js";

const NOW = 1_000_000;

const repo: CommandParameter = {
  name: "repo",
  label: "Repository",
  type: "text",
  required: true,
};

function output(overrides: Partial<CommandOutput> = {}): CommandOutput {
  return {
    id: "out_1" as OutputId,
    commandId: "cmd_1" as CommandId,
    name: "plan",
    kind: "document",
    publishedAt: null,
    boundObjectId: null,
    boundRunId: null,
    boundAt: null,
    brokenAt: null,
    ...overrides,
  };
}

describe("ask-points: irreversibility pierces pre-grants (§6.6)", () => {
  it("always asks before an irreversible write, declared or not", () => {
    expect(effectiveAskPoints([])).toContain("irreversible_write");
  });

  it("keeps what the definition declared", () => {
    expect(effectiveAskPoints(["external_write"])).toEqual([
      "external_write",
      "irreversible_write",
    ]);
  });

  it("does not duplicate a declared always-ask point", () => {
    expect(effectiveAskPoints(["irreversible_write"])).toEqual([
      "irreversible_write",
    ]);
  });
});

describe("parameters: a derived default is a proposal, never applied (§3.5)", () => {
  const proposal: ParameterBinding = {
    name: "repo",
    state: "proposed",
    proposal: "plotroom",
    derivedFrom: "the workstream's subject ticket",
  };

  it("refuses to resolve while a proposal is unconfirmed", () => {
    const resolution = resolveParameters([repo], [proposal]);

    expect(resolution.ready).toBe(false);
    if (resolution.ready) return;
    expect(resolution.unconfirmed).toEqual(["repo"]);
    // The proposed value is nowhere in the result: it was never applied.
    expect(JSON.stringify(resolution)).not.toContain("plotroom");
  });

  it("reports a required parameter with no binding as missing", () => {
    const resolution = resolveParameters([repo], []);

    expect(resolution.ready).toBe(false);
    if (resolution.ready) return;
    expect(resolution.missing).toEqual(["repo"]);
  });

  it("resolves once the user confirms the proposal", () => {
    const confirmed = confirmParameter(proposal, NOW);
    const resolution = resolveParameters([repo], [confirmed]);

    expect(confirmed.state).toBe("confirmed");
    expect(resolution).toEqual({ ready: true, values: { repo: "plotroom" } });
  });

  it("lets the user confirm a different value than the one proposed", () => {
    const confirmed = confirmParameter(proposal, NOW, "other-repo");

    expect(resolveParameters([repo], [confirmed])).toEqual({
      ready: true,
      values: { repo: "other-repo" },
    });
  });

  it("ignores an unbound optional parameter", () => {
    expect(resolveParameters([{ ...repo, required: false }], [])).toEqual({
      ready: true,
      values: {},
    });
  });
});

describe("content budget: warn, refuse, never truncate (§3.5, principle 12)", () => {
  const budget: ContentBudget = {
    modelWindowTokens: 1000,
    warnAtFraction: 0.8,
    hardCapTokens: null,
  };

  it("proceeds well under the window", () => {
    expect(checkContentBudget(100, budget)).toEqual({
      state: "ok",
      estimatedTokens: 100,
    });
  });

  it("warns as content approaches the model's window", () => {
    expect(checkContentBudget(850, budget).state).toBe("warn");
  });

  it("refuses over an opt-in hard cap rather than truncating", () => {
    const capped = checkContentBudget(900, { ...budget, hardCapTokens: 500 });

    expect(capped.state).toBe("refused");
    // There is no third answer: the result carries no truncation instruction.
    expect(Object.keys(capped).sort()).toEqual([
      "estimatedTokens",
      "message",
      "state",
    ]);
  });

  it("has no hard cap unless the command opts in", () => {
    expect(checkContentBudget(999, budget).state).toBe("warn");
  });
});

describe("publish and promote are two verbs (§3.5, §3.2)", () => {
  it("publishes a placeholder before any run", () => {
    expect(checkPublish(output())).toEqual({ allowed: true });
  });

  it("refuses publish once the output has bound, pointing at promote", () => {
    const check = checkPublish(output({ boundObjectId: "obj_9" as ObjectId }));

    expect(check.allowed).toBe(false);
    if (check.allowed) return;
    expect(check.refusal.reason).toBe("already_bound");
    expect(check.refusal.message).toContain("promote");
  });
});

describe("output pre-wiring and the two-state rule (§3.5)", () => {
  it("is pre-bind until a run produces something", () => {
    expect(outputBindState(output())).toBe("pre_bind");
    expect(
      outputBindState(
        output({
          boundObjectId: "obj_9" as ObjectId,
          boundRunId: "run_1" as RunId,
          boundAt: NOW,
        }),
      ),
    ).toBe("post_bind");
  });

  it("leaves a visibly broken placeholder when a pre-bind producer is deleted", () => {
    const effect = effectOfDeletingProducer(output());

    expect(effect.effect).toBe("broken_placeholder");
    if (effect.effect !== "broken_placeholder") return;
    expect(effect.message).toContain("still blocked");
  });

  it("leaves the produced object intact when a post-bind producer is deleted", () => {
    expect(
      effectOfDeletingProducer(output({ boundObjectId: "obj_9" as ObjectId })),
    ).toEqual({ effect: "object_intact", objectId: "obj_9" });
  });
});

describe("cross-workstream wires require publishing (§3.5)", () => {
  const home = "ws_1" as WorkstreamId;
  const other = "ws_2" as WorkstreamId;
  const facts = {
    workstreamId: home,
    published: false,
    broken: false,
    boundScope: null,
  };

  it("allows an unpublished placeholder inside its own workstream", () => {
    expect(checkOutputCrossing(facts, home)).toEqual({ legal: true });
  });

  it("refuses an unpublished placeholder crossing out", () => {
    const check = checkOutputCrossing(facts, other);

    expect(check.legal).toBe(false);
    if (check.legal) return;
    expect(check.refusal.reason).toBe("unpublished_output");
  });

  it("allows a published placeholder to cross", () => {
    expect(checkOutputCrossing({ ...facts, published: true }, other)).toEqual({
      legal: true,
    });
  });

  it("allows a bound output whose object was promoted to world scope", () => {
    expect(
      checkOutputCrossing(
        { ...facts, published: true, boundScope: "world" },
        other,
      ),
    ).toEqual({ legal: true });
  });

  it("refuses a bound output that produced a local object", () => {
    // The gap this closes: binding without publishing leaves the object local,
    // and being bound is not licence to carry it out of its workstream (§3.3).
    const check = checkOutputCrossing(
      { ...facts, published: false, boundScope: "local" },
      other,
    );

    expect(check.legal).toBe(false);
    if (check.legal) return;
    expect(check.refusal.reason).toBe("local_bound_output");
    expect(check.refusal.message).toContain("promote");
  });

  it("refuses a local bound object even when the placeholder was published", () => {
    // Publishing is a promise about a placeholder; the object's own scope is
    // what decides once one exists, so the two cannot disagree silently.
    const check = checkOutputCrossing(
      { ...facts, published: true, boundScope: "local" },
      other,
    );

    expect(check.legal).toBe(false);
    if (check.legal) return;
    expect(check.refusal.reason).toBe("local_bound_output");
  });

  it("allows a local bound object to stay inside its own workstream", () => {
    expect(
      checkOutputCrossing({ ...facts, boundScope: "local" }, home),
    ).toEqual({ legal: true });
  });

  it("refuses a broken placeholder outright", () => {
    const check = checkOutputCrossing(
      { ...facts, published: true, broken: true },
      home,
    );

    expect(check.legal).toBe(false);
    if (check.legal) return;
    expect(check.refusal.reason).toBe("broken_output");
  });
});

describe("completion is proof, not a claim (§3.5)", () => {
  const outcome: ExpectedOutcome = {
    name: "pull_request",
    kind: "pull_request",
    conditions: [
      {
        id: "pr",
        predicate: "pull_request_exists",
        description: "a PR exists",
      },
      { id: "ci", predicate: "checks_green", description: "checks are green" },
    ],
  };

  it("accepts a submission whose conditions all hold", () => {
    const result = checkSubmission(
      outcome,
      [
        { conditionId: "pr", holds: true },
        { conditionId: "ci", holds: true },
      ],
      NOW,
    );

    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.proof.provenAt).toBe(NOW);
    expect(result.proof.conditions).toHaveLength(2);
  });

  it("rejects a submission and returns the failing condition as feedback", () => {
    const result = checkSubmission(
      outcome,
      [
        { conditionId: "pr", holds: true },
        { conditionId: "ci", holds: false, detail: "lint failed" },
      ],
      NOW,
    );

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.failed.map((each) => each.conditionId)).toEqual(["ci"]);
    expect(result.feedback).toContain("lint failed");
  });

  it("treats an unevaluated condition as unproven, not as passing", () => {
    const result = checkSubmission(
      outcome,
      [{ conditionId: "pr", holds: true }],
      NOW,
    );

    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.failed[0]?.detail).toContain("never checked");
  });

  it("accepts an outcome with no conditions", () => {
    expect(
      checkSubmission({ ...outcome, conditions: [] }, [], NOW).accepted,
    ).toBe(true);
  });
});
