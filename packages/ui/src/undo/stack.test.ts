import { describe, expect, it } from "vitest";

import { createUndoStack } from "./stack.js";

interface State {
  readonly items: readonly string[];
}

function removeOp(id: string) {
  return {
    label: `delete ${id}`,
    apply: (state: State): State => ({
      items: state.items.filter((i) => i !== id),
    }),
    invert: (state: State): State => ({ items: [...state.items, id] }),
  };
}

describe("createUndoStack", () => {
  it("has nothing to undo initially", () => {
    const stack = createUndoStack<State>();
    expect(stack.canUndo()).toBe(false);
    expect(stack.undo({ items: [] })).toBeNull();
  });

  it("applies an operation and reverses it on undo", () => {
    const stack = createUndoStack<State>();
    const state = stack.do({ items: ["a", "b"] }, removeOp("a"));
    expect(state).toEqual({ items: ["b"] });

    const result = stack.undo(state);
    expect(result).toEqual({ state: { items: ["b", "a"] }, label: "delete a" });
  });

  it("undoes multiple operations in reverse order", () => {
    const stack = createUndoStack<State>();
    let state: State = { items: ["a", "b", "c"] };
    state = stack.do(state, removeOp("a"));
    state = stack.do(state, removeOp("b"));
    expect(state).toEqual({ items: ["c"] });

    const first = stack.undo(state);
    expect(first?.label).toBe("delete b");
    const second = stack.undo(first!.state);
    expect(second?.label).toBe("delete a");
    expect(stack.canUndo()).toBe(false);
  });

  it("drops the oldest operation once maxDepth is exceeded", () => {
    const stack = createUndoStack<State>(2);
    let state: State = { items: ["a", "b", "c"] };
    state = stack.do(state, removeOp("a"));
    state = stack.do(state, removeOp("b"));
    state = stack.do(state, removeOp("c"));
    expect(stack.size()).toBe(2);

    // Oldest (delete a) was evicted; only b and c are undoable.
    const first = stack.undo(state);
    expect(first?.label).toBe("delete c");
    const second = stack.undo(first!.state);
    expect(second?.label).toBe("delete b");
    expect(stack.canUndo()).toBe(false);
  });
});
