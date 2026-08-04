import { describe, expect, it } from "vitest";
import {
  assembleRunBody,
  estimateRunCost,
  formatMicros,
  isRunCompactable,
  DEFAULT_RUN_RETENTION_POLICY,
  type RunRetentionFacts,
} from "./runs.js";

const NOW = 1_000_000;
const WINDOW = DEFAULT_RUN_RETENTION_POLICY.windowSeconds;
const KEEP = DEFAULT_RUN_RETENTION_POLICY.keepPerDefinition;

function run(overrides: Partial<RunRetentionFacts> = {}): RunRetentionFacts {
  return {
    pinned: false,
    startedAt: NOW - WINDOW - 1,
    recencyRank: KEEP + 1,
    addressedByLatest: false,
    ...overrides,
  };
}

const context = { now: NOW, policy: DEFAULT_RUN_RETENTION_POLICY };

describe("the run-history retention rule (spec §4.4)", () => {
  it("compacts an old, unpinned run past the last N for its definition", () => {
    expect(isRunCompactable(run(), context)).toBe(true);
  });

  it("keeps the last N runs per definition", () => {
    expect(isRunCompactable(run({ recencyRank: KEEP }), context)).toBe(false);
  });

  it("never compacts a pinned run", () => {
    expect(isRunCompactable(run({ pinned: true }), context)).toBe(false);
  });

  it("never compacts the run `latest` resolves to", () => {
    expect(isRunCompactable(run({ addressedByLatest: true }), context)).toBe(
      false,
    );
  });

  it("keeps everything inside the configurable window", () => {
    expect(isRunCompactable(run({ startedAt: NOW - 10 }), context)).toBe(false);
  });

  it("honours a narrower configured window", () => {
    expect(
      isRunCompactable(run({ startedAt: NOW - 100 }), {
        now: NOW,
        policy: { keepPerDefinition: 1, windowSeconds: 50 },
      }),
    ).toBe(true);
  });
});

describe("cost estimates state their basis and render as ranges (§4.1)", () => {
  it("prices from this definition's own run history", () => {
    const estimate = estimateRunCost({
      inputTokens: 1_200,
      priorRuns: [
        { costMicros: 30_000, inputTokens: 1_000, outputTokens: 300 },
        { costMicros: 10_000, inputTokens: 900, outputTokens: 200 },
        { costMicros: 20_000, inputTokens: 1_100, outputTokens: 250 },
      ],
    });

    expect(estimate.basis).toBe("prior-runs");
    expect(estimate.priorRuns).toBe(3);
    expect(estimate.range).toEqual({
      lowMicros: 10_000,
      highMicros: 30_000,
      medianMicros: 20_000,
    });
    // A range and its basis, in words — never a bare number.
    expect(estimate.description).toBe(
      "$0.01–$0.03 based on 3 prior runs of this definition",
    );
  });

  it("says so, and prices nothing, when there is no history", () => {
    const estimate = estimateRunCost({ inputTokens: 4_000, priorRuns: [] });

    expect(estimate.basis).toBe("input-size-only");
    expect(estimate.priorRuns).toBe(0);
    // Null rather than zero: there is no number to render, so none is offered.
    expect(estimate.range).toBeNull();
    expect(estimate.inputTokens).toBe(4_000);
    expect(estimate.description).toMatch(/no priced history/);
    expect(estimate.description).toMatch(/input size only/);
  });

  it("ignores runs whose runtime reported no cost, rather than averaging in a zero", () => {
    const estimate = estimateRunCost({
      inputTokens: 100,
      priorRuns: [
        { costMicros: 0, inputTokens: 100, outputTokens: 10 },
        { costMicros: 50_000, inputTokens: 100, outputTokens: 10 },
      ],
    });

    expect(estimate.basis).toBe("prior-runs");
    expect(estimate.priorRuns).toBe(1);
    expect(estimate.range).toEqual({
      lowMicros: 50_000,
      highMicros: 50_000,
      medianMicros: 50_000,
    });
    // One run is still a range, and it says it is one run.
    expect(estimate.description).toMatch(
      /based on 1 prior run of this definition/,
    );
  });

  it("keeps every priced run's evidence with no history at all priced away", () => {
    const estimate = estimateRunCost({
      inputTokens: 100,
      priorRuns: [{ costMicros: 0, inputTokens: 100, outputTokens: 10 }],
    });

    // A history that recorded no money is no evidence about money.
    expect(estimate.basis).toBe("input-size-only");
    expect(estimate.range).toBeNull();
  });

  it("takes the median of an even number of priced runs", () => {
    const estimate = estimateRunCost({
      inputTokens: 10,
      priorRuns: [
        { costMicros: 1_000, inputTokens: 1, outputTokens: 1 },
        { costMicros: 2_000, inputTokens: 1, outputTokens: 1 },
        { costMicros: 3_000, inputTokens: 1, outputTokens: 1 },
        { costMicros: 6_000, inputTokens: 1, outputTokens: 1 },
      ],
    });

    expect(estimate.range?.medianMicros).toBe(2_500);
  });

  it("formats money from integer micros, once, for every surface", () => {
    expect(formatMicros(1_500_000)).toBe("$1.50");
    expect(formatMicros(2_500)).toBe("$0.0025");
  });
});

describe("assembling what the runtime is handed (§3.5, §15-1)", () => {
  const inputs = [
    { title: "House rules", content: "This repository uses pnpm, never npm." },
    { title: "OXY-1", content: "The login button does nothing." },
  ];

  it("puts the instruction in the bytes, ahead of every input", () => {
    const body = assembleRunBody({
      instruction: "Fix the ticket and open a pull request.",
      inputs,
    });

    expect(body).toContain("Fix the ticket and open a pull request.");
    expect(body.indexOf("Fix the ticket")).toBeLessThan(body.indexOf("pnpm"));
    expect(body.indexOf("pnpm")).toBeLessThan(body.indexOf("login button"));
  });

  it("keeps the instruction one heading level above the inputs", () => {
    const body = assembleRunBody({ instruction: "Do it.", inputs });

    expect(body.startsWith("# Instruction\n\nDo it.")).toBe(true);
    expect(body).toContain("## OXY-1\n\nThe login button does nothing.");
  });

  it("delivers confirmed parameter values with the instruction", () => {
    const body = assembleRunBody({
      instruction: "Review the diff in $repo.",
      parameters: [
        { name: "repo", label: "Repository", value: "plotroom" },
        { name: "strict", label: "strict", value: true },
        { name: "depth", label: "Commits", value: 20 },
      ],
      inputs,
    });

    expect(body).toContain("- **repo** (Repository): plotroom");
    // A label that only repeats the name says nothing worth a parenthesis.
    expect(body).toContain("- **strict**: true");
    expect(body).toContain("- **depth** (Commits): 20");
    expect(body.indexOf("plotroom")).toBeLessThan(body.indexOf("pnpm"));
  });

  it("renders parameters in the order given rather than sorting them", () => {
    const body = assembleRunBody({
      instruction: "Go.",
      parameters: [
        { name: "repo", label: "Repository", value: "plotroom" },
        { name: "depth", label: "Commits", value: 20 },
      ],
      inputs,
    });

    // Alphabetical would put `depth` first. The caller's order is the answer,
    // because that is what makes two runs of one definition assemble alike.
    expect(body.indexOf("**repo**")).toBeGreaterThan(-1);
    expect(body.indexOf("**repo**")).toBeLessThan(body.indexOf("**depth**"));
  });

  it("keeps a multi-line value one parameter instead of several", () => {
    const body = assembleRunBody({
      instruction: "Go.",
      parameters: [
        {
          name: "standard",
          label: "Review standard",
          value: "- no bare catch\n## not a heading",
        },
      ],
      inputs: [],
    });

    // Interpolated after the colon, that value would read as two more list
    // items and a heading beside the inputs' own `##` sections.
    expect(body).toBe(
      "# Instruction\n\nGo.\n\nParameters:\n\n- **standard** (Review standard):\n  - no bare catch\n  ## not a heading",
    );
  });

  it("writes no empty heading for a definition with nothing to say", () => {
    const body = assembleRunBody({ instruction: "   ", inputs });

    expect(body).not.toContain("# Instruction");
    expect(body.startsWith("## House rules")).toBe(true);
  });

  it("still frames parameters when the instruction itself is empty", () => {
    const body = assembleRunBody({
      instruction: "",
      parameters: [{ name: "repo", label: "Repository", value: "plotroom" }],
      inputs: [],
    });

    expect(body).toBe(
      "# Instruction\n\nParameters:\n\n- **repo** (Repository): plotroom",
    );
  });

  it("assembles an instruction with no inputs at all", () => {
    expect(assembleRunBody({ instruction: "Just go.", inputs: [] })).toBe(
      "# Instruction\n\nJust go.",
    );
  });
});
