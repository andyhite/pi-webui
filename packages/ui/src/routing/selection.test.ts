import { describe, expect, it } from "vitest";

import { searchForSelection, selectionFromSearch } from "./selection.js";

describe("selectionFromSearch", () => {
  it("returns null for an empty query", () => {
    expect(selectionFromSearch("")).toBeNull();
    expect(selectionFromSearch("?")).toBeNull();
  });

  it("returns null when the node param is absent or empty", () => {
    expect(selectionFromSearch("?other=1")).toBeNull();
    expect(selectionFromSearch("?node=")).toBeNull();
  });

  it("reads the selected node id", () => {
    expect(selectionFromSearch("?node=abc")).toBe("abc");
  });

  it("decodes percent-encoded ids", () => {
    expect(selectionFromSearch("?node=a%2Fb")).toBe("a/b");
  });
});

describe("searchForSelection", () => {
  it("addresses a node from an empty query", () => {
    expect(searchForSelection("", "abc")).toBe("?node=abc");
  });

  it("replaces an existing selection", () => {
    expect(searchForSelection("?node=old", "new")).toBe("?node=new");
  });

  it("clears the selection", () => {
    expect(searchForSelection("?node=old", null)).toBe("");
  });

  it("preserves unrelated params", () => {
    expect(searchForSelection("?zoom=2&node=old", "new")).toBe(
      "?zoom=2&node=new",
    );
    expect(searchForSelection("?zoom=2&node=old", null)).toBe("?zoom=2");
  });

  it("round-trips ids that need encoding", () => {
    const search = searchForSelection("", "a/b c");
    expect(selectionFromSearch(search)).toBe("a/b c");
  });
});
