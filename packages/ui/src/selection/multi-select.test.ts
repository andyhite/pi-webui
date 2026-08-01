import { describe, expect, it } from "vitest";

import {
  actionsForSelection,
  applyMarqueeSelection,
  applySelectionClick,
  nodesInMarquee,
} from "./multi-select.js";

describe("nodesInMarquee", () => {
  const nodes = [
    { id: "a", x: 0, y: 0, width: 100, height: 50 },
    { id: "b", x: 200, y: 0, width: 100, height: 50 },
    { id: "c", x: 50, y: 100, width: 100, height: 50 },
  ];

  it("returns nodes overlapping the rectangle", () => {
    expect(
      nodesInMarquee(nodes, { x: 0, y: 0, width: 60, height: 60 }),
    ).toEqual(["a"]);
  });

  it("returns nothing when the rectangle touches no node", () => {
    expect(
      nodesInMarquee(nodes, { x: 500, y: 500, width: 10, height: 10 }),
    ).toEqual([]);
  });

  it("returns multiple nodes spanned by a large rectangle", () => {
    expect(
      nodesInMarquee(nodes, { x: 0, y: 0, width: 400, height: 200 }),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("applySelectionClick", () => {
  it("replace sets the selection to just that node", () => {
    expect(applySelectionClick(new Set(["a", "b"]), "c", "replace")).toEqual(
      new Set(["c"]),
    );
  });

  it("add includes the node without removing existing ones", () => {
    expect(applySelectionClick(new Set(["a"]), "b", "add")).toEqual(
      new Set(["a", "b"]),
    );
  });

  it("toggle removes an already-selected node", () => {
    expect(applySelectionClick(new Set(["a", "b"]), "a", "toggle")).toEqual(
      new Set(["b"]),
    );
  });

  it("toggle adds a not-yet-selected node", () => {
    expect(applySelectionClick(new Set(["a"]), "b", "toggle")).toEqual(
      new Set(["a", "b"]),
    );
  });
});

describe("applyMarqueeSelection", () => {
  it("replace overwrites the current selection", () => {
    expect(
      applyMarqueeSelection(new Set(["a"]), ["b", "c"], "replace"),
    ).toEqual(new Set(["b", "c"]));
  });

  it("add unions with the current selection", () => {
    expect(applyMarqueeSelection(new Set(["a"]), ["b", "c"], "add")).toEqual(
      new Set(["a", "b", "c"]),
    );
  });
});

describe("actionsForSelection", () => {
  it("returns nothing for an empty selection", () => {
    expect(actionsForSelection([])).toEqual([]);
  });

  it("offers delete for any non-empty mixed-role selection", () => {
    expect(actionsForSelection(["content", "command"])).toEqual(["delete"]);
  });

  it("offers content actions when every node is content", () => {
    expect(actionsForSelection(["content", "content"])).toEqual([
      "delete",
      "promote",
      "wireAsContext",
    ]);
  });

  it("offers session actions when every node is a session", () => {
    expect(actionsForSelection(["session", "session"])).toEqual([
      "delete",
      "stop",
      "close",
      "archive",
    ]);
  });
});
