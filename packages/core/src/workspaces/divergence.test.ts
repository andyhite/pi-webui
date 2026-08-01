import { describe, expect, it } from "vitest";

import {
  checkContinuation,
  deriveDivergence,
  digestPaths,
  forcesFresh,
  type UnitFingerprint,
  type WorkspaceFingerprint,
} from "./divergence.js";
import { GIT_WORKSPACE_KIND } from "./kind.js";

const NOW = 1_700_000_000_000;

function unit(overrides: Partial<UnitFingerprint> = {}): UnitFingerprint {
  return {
    rootKey: "root",
    head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    branch: "feat/thing",
    upstream: "origin/feat/thing",
    upstreamHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    dirtyDigest: digestPaths([]),
    dirtyCount: 0,
    ...overrides,
  };
}

function fingerprint(
  units: readonly UnitFingerprint[],
  observedAt = NOW,
): WorkspaceFingerprint {
  return { kind: GIT_WORKSPACE_KIND, observedAt, units };
}

const reachable = (value: boolean) => ({
  priorHeadReachable: new Map([["root", value]]),
});

describe("deriveDivergence", () => {
  it("reports nothing when the workspace stands where it stood", () => {
    const report = deriveDivergence(
      fingerprint([unit()]),
      fingerprint([unit()]),
    );

    expect(report.diverged).toBe(false);
    expect(checkContinuation(report).allowed).toBe(true);
  });

  it("calls an unreachable prior head a rewrite — a rebase (§3.4)", () => {
    const report = deriveDivergence(
      fingerprint([unit()]),
      fingerprint([unit({ head: "b".repeat(40) })]),
      reachable(false),
    );

    expect(report.changes.map((change) => change.kind)).toContain(
      "history-rewritten",
    );
    expect(checkContinuation(report).allowed).toBe(false);
  });

  it("calls a reachable prior head new commits — a merge someone else landed", () => {
    const report = deriveDivergence(
      fingerprint([unit()]),
      fingerprint([unit({ head: "b".repeat(40) })]),
      reachable(true),
    );

    expect(report.changes.map((change) => change.kind)).toEqual([
      "commits-added",
    ]);
    expect(checkContinuation(report).allowed).toBe(false);
  });

  it("refuses to guess when ancestry could not be checked", () => {
    const report = deriveDivergence(
      fingerprint([unit()]),
      fingerprint([unit({ head: "b".repeat(40) })]),
    );

    expect(report.changes[0]?.kind).toBe("unknown");
    expect(checkContinuation(report).allowed).toBe(false);
  });

  it("detects a switched branch", () => {
    const report = deriveDivergence(
      fingerprint([unit()]),
      fingerprint([unit({ branch: "main" })]),
    );

    expect(report.changes.map((change) => change.kind)).toContain(
      "branch-changed",
    );
    expect(checkContinuation(report).allowed).toBe(false);
  });

  it("does not force fresh on hand edits — the operator is an implicit claim holder (§3.4)", () => {
    const report = deriveDivergence(
      fingerprint([unit()]),
      fingerprint([
        unit({ dirtyDigest: digestPaths(["src/auth.ts"]), dirtyCount: 1 }),
      ]),
    );

    expect(report.diverged).toBe(true);
    expect(report.changes.map((change) => change.kind)).toEqual([
      "uncommitted-changed",
    ]);
    expect(checkContinuation(report).allowed).toBe(true);
  });

  it("reports an upstream that moved without moving the workspace", () => {
    const report = deriveDivergence(
      fingerprint([unit()]),
      fingerprint([unit({ upstreamHead: "c".repeat(40) })]),
    );

    expect(report.changes.map((change) => change.kind)).toEqual([
      "upstream-moved",
    ]);
    expect(checkContinuation(report).allowed).toBe(true);
  });

  it("compares per root, so a composite kind diverges in one of them (§13)", () => {
    const before = fingerprint([
      unit({ rootKey: "frontend" }),
      unit({ rootKey: "backend" }),
    ]);
    const after = fingerprint([
      unit({ rootKey: "frontend" }),
      unit({ rootKey: "backend", head: "d".repeat(40) }),
    ]);

    const report = deriveDivergence(before, after, {
      priorHeadReachable: new Map([["backend", false]]),
    });

    expect(report.changes).toEqual([
      expect.objectContaining({
        rootKey: "backend",
        kind: "history-rewritten",
      }),
    ]);
  });

  it("reports a root that appeared or vanished", () => {
    const before = fingerprint([unit({ rootKey: "frontend" })]);
    const after = fingerprint([unit({ rootKey: "backend" })]);

    const report = deriveDivergence(before, after);

    expect(report.changes.map((change) => change.kind)).toEqual([
      "roots-changed",
      "roots-changed",
    ]);
    expect(checkContinuation(report).allowed).toBe(false);
  });

  it("refuses a verdict across kinds rather than inventing one", () => {
    const report = deriveDivergence(
      { kind: "git", observedAt: NOW, units: [unit()] },
      { kind: "docs", observedAt: NOW, units: [unit()] },
    );

    expect(report.changes).toEqual([
      expect.objectContaining({ kind: "unknown" }),
    ]);
  });

  it("names what blocked continuation, in the operator's words (§4.3)", () => {
    const report = deriveDivergence(
      fingerprint([unit()]),
      fingerprint([unit({ head: "b".repeat(40) })]),
      reachable(false),
    );

    const gate = checkContinuation(report);

    expect(gate.message).toContain("changed outside this session");
    expect(gate.blocking).toHaveLength(1);
  });
});

describe("forcesFresh", () => {
  it("is exhaustive over the divergence vocabulary", () => {
    expect(forcesFresh("history-rewritten")).toBe(true);
    expect(forcesFresh("branch-changed")).toBe(true);
    expect(forcesFresh("commits-added")).toBe(true);
    expect(forcesFresh("roots-changed")).toBe(true);
    expect(forcesFresh("unknown")).toBe(true);
    expect(forcesFresh("upstream-moved")).toBe(false);
    expect(forcesFresh("uncommitted-changed")).toBe(false);
  });
});

describe("digestPaths", () => {
  it("is order-independent and change-sensitive", () => {
    expect(digestPaths(["a", "b"])).toBe(digestPaths(["b", "a"]));
    expect(digestPaths(["a", "b"])).not.toBe(digestPaths(["a", "c"]));
    expect(digestPaths(["ab"])).not.toBe(digestPaths(["a", "b"]));
  });
});
