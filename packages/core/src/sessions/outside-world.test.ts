import { describe, expect, it } from "vitest";

import {
  declareToolWorld,
  deriveOutsideWorldMarkers,
  forkCleanlinessAt,
  forkPointMarkers,
  NO_TOOL_WORLD_DECLARATIONS,
  type ToolWorldDeclaration,
} from "./outside-world.js";
import type { RuntimeObservation } from "./runtime.js";

const declarations = declareToolWorld({
  read: { kind: "local", reason: "reads a file in the workspace" },
  edit: { kind: "local", reason: "writes inside the workspace" },
  github_comment: {
    kind: "outside-world",
    system: "github",
    action: "comment",
    reversibility: "reversible",
  },
  github_merge: {
    kind: "outside-world",
    system: "github",
    action: "merge",
    reversibility: "irreversible",
  },
});

function turn(n: number, at: number): RuntimeObservation {
  return { kind: "turn-started", turn: n, at };
}

function call(
  toolName: string,
  callId: string,
  at: number,
): readonly RuntimeObservation[] {
  return [
    { kind: "tool-started", toolName, callId, input: {}, at },
    { kind: "tool-finished", callId, output: "ok", isError: false, at: at + 1 },
  ];
}

/** Turn 1 reads, turn 2 comments on a PR, turn 3 merges it. */
const observations: readonly RuntimeObservation[] = [
  turn(1, 1_000),
  ...call("read", "c1", 1_010),
  ...call("edit", "c2", 1_020),
  turn(2, 2_000),
  ...call("github_comment", "c3", 2_010),
  turn(3, 3_000),
  ...call("github_merge", "c4", 3_010),
];

describe("markers come from declarations, not from heuristics (§6.6)", () => {
  it("records a touch per declared outside-world write, with its turn", () => {
    const markers = deriveOutsideWorldMarkers(observations, declarations);

    expect(markers.turns).toEqual([1, 2, 3]);
    expect(markers.touches).toEqual([
      {
        turn: 2,
        callId: "c3",
        toolName: "github_comment",
        system: "github",
        action: "comment",
        reversibility: "reversible",
        outcome: "succeeded",
        at: 2_010,
      },
      {
        turn: 3,
        callId: "c4",
        toolName: "github_merge",
        system: "github",
        action: "merge",
        reversibility: "irreversible",
        outcome: "succeeded",
        at: 3_010,
      },
    ]);
    expect(markers.undeclared).toEqual([]);
  });

  it("counts a local tool as no touch at all", () => {
    const markers = deriveOutsideWorldMarkers(
      [turn(1, 1_000), ...call("edit", "c1", 1_010)],
      declarations,
    );

    expect(markers.touches).toEqual([]);
    expect(markers.undeclared).toEqual([]);
  });

  it("counts an undeclared tool as undeclared, never as harmless", () => {
    const markers = deriveOutsideWorldMarkers(
      [turn(1, 1_000), ...call("bash", "c1", 1_010)],
      declarations,
    );

    expect(markers.touches).toEqual([]);
    expect(markers.undeclared).toEqual([
      { turn: 1, callId: "c1", toolName: "bash", at: 1_010 },
    ]);
  });

  it("keeps a failed write as a touch: it may still have landed", () => {
    const markers = deriveOutsideWorldMarkers(
      [
        turn(1, 1_000),
        {
          kind: "tool-started",
          toolName: "github_merge",
          callId: "c1",
          input: {},
          at: 1_010,
        },
        {
          kind: "tool-finished",
          callId: "c1",
          output: "409",
          isError: true,
          at: 1_020,
        },
      ],
      declarations,
    );

    expect(markers.touches).toHaveLength(1);
    expect(markers.touches[0]?.outcome).toBe("failed");
  });

  it("keeps an unfinished write as a touch too", () => {
    const markers = deriveOutsideWorldMarkers(
      [
        turn(1, 1_000),
        {
          kind: "tool-started",
          toolName: "github_merge",
          callId: "c1",
          input: {},
          at: 1_010,
        },
      ],
      declarations,
    );

    expect(markers.touches[0]?.outcome).toBe("unfinished");
  });
});

describe("fork-before-clean, fork-after-dirty (§6.3)", () => {
  const markers = deriveOutsideWorldMarkers(observations, declarations);

  it("is clean at a turn before the first touch", () => {
    const cleanliness = forkCleanlinessAt(markers, 1);

    expect(cleanliness.clean).toBe(true);
    expect(cleanliness.certain).toBe(true);
    expect(cleanliness.touches).toEqual([]);
    expect(cleanliness.description).toContain("clean");
  });

  it("is dirty from the turn the touch happened in, inclusively", () => {
    // A fork at turn 2 inherits turn 2, which is where the comment happened.
    const atTwo = forkCleanlinessAt(markers, 2);
    expect(atTwo.clean).toBe(false);
    expect(atTwo.touches).toHaveLength(1);
    expect(atTwo.irreversible).toEqual([]);

    const atThree = forkCleanlinessAt(markers, 3);
    expect(atThree.touches).toHaveLength(2);
    expect(atThree.irreversible).toHaveLength(1);
    expect(atThree.description).toContain("irreversible");
  });

  it("marks every observed turn, so the transcript can draw them", () => {
    expect(
      forkPointMarkers(markers).map((marker) => [marker.turn, marker.clean]),
    ).toEqual([
      [1, true],
      [2, false],
      [3, false],
    ]);
  });

  it("loses certainty, not cleanliness, when a call was undeclared", () => {
    const withBash = deriveOutsideWorldMarkers(
      [turn(1, 1_000), ...call("bash", "c1", 1_010)],
      declarations,
    );
    const cleanliness = forkCleanlinessAt(withBash, 1);

    expect(cleanliness.clean).toBe(true);
    expect(cleanliness.certain).toBe(false);
    expect(cleanliness.description).toContain("as far as declarations go");
    expect(cleanliness.undeclaredCalls).toHaveLength(1);
  });

  it("with nothing declared, reports every call as undeclared", () => {
    const nothing = deriveOutsideWorldMarkers(
      observations,
      NO_TOOL_WORLD_DECLARATIONS,
    );

    expect(nothing.touches).toEqual([]);
    expect(nothing.undeclared).toHaveLength(4);
    expect(forkCleanlinessAt(nothing, 3).certain).toBe(false);
  });

  it("cannot express a declaration that forgot to say", () => {
    // Two variants and no default: `kind` is the discriminant, and there is no
    // third value that means "we did not check".
    // @ts-expect-error a declaration states local or outside-world, never neither
    const vague: ToolWorldDeclaration = { kind: "unknown" };
    expect(vague).toBeDefined();
  });
});
