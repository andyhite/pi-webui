---
description: ALLOW_MAIN_COMMIT is the operator's escape hatch, never an agent's — nothing you do happens on main
condition: "ALLOW_MAIN_COMMIT"
scope: "tool:bash"
interruptMode: tool-only
---

`.husky/pre-commit` refuses a commit on `main` unless `ALLOW_MAIN_COMMIT=1`
is set. That override exists for the operator, not for you:

- Every agent change lands through a branch in its own worktree and a pull
  request the operator approves. There is no size of change — a typo, a
  one-line doc fix — that earns a direct commit.
- The hook refusing you is not the obstacle; being on `main` is. Create the
  worktree (`skill://worktree`) and commit there.

If you believe you have a genuine exception, say so and stop — the operator
sets the variable, not you.
