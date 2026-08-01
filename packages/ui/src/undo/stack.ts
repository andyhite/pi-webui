/**
 * Undo for destructive canvas operations (spec §5, principle 10): delete
 * node/edge/workstream, clear region. A generic command-pattern stack —
 * every destructive op pushes its own inverse, so undo never has to guess
 * how to reverse an arbitrary state diff.
 */

export interface UndoableOperation<S> {
  readonly label: string;
  readonly apply: (state: S) => S;
  readonly invert: (state: S) => S;
}

export interface UndoResult<S> {
  readonly state: S;
  readonly label: string;
}

export interface UndoStack<S> {
  /** Applies the operation and records it; returns the new state. */
  do(state: S, op: UndoableOperation<S>): S;
  /** Reverses the most recent operation, or null if there is nothing to undo. */
  undo(state: S): UndoResult<S> | null;
  canUndo(): boolean;
  /** Depth for tests/inspection; not part of the product surface. */
  size(): number;
}

/**
 * `maxDepth` bounds memory on a long session; the oldest operation is
 * dropped once the cap is reached, same trade-off as any editor's undo ring.
 */
export function createUndoStack<S>(maxDepth = 50): UndoStack<S> {
  const stack: UndoableOperation<S>[] = [];

  return {
    do(state, op) {
      stack.push(op);
      if (stack.length > maxDepth) stack.shift();
      return op.apply(state);
    },
    undo(state) {
      const op = stack.pop();
      if (!op) return null;
      return { state: op.invert(state), label: op.label };
    },
    canUndo() {
      return stack.length > 0;
    },
    size() {
      return stack.length;
    },
  };
}
