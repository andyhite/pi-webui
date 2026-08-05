---
description: Get an independent review of a branch or pull request, and record it where it belongs
---

Review the change for **#$1** — an issue number, or a pull request number if you say so.
`AGENTS.md` requires that somebody who did not write the change reads it before it
lands, and that the review is recorded on the pull request.

## 1. Find what is being reviewed

The worktree, the branch, the pull request if one is open (`gh pr list --head <branch>`),
and the item: `issue://$1`. If there is no pull request yet, open it first — a review
recorded nowhere is one the next reader has to redo.

## 2. Dispatch a reader with fresh context

Use the `plotroom-review` agent, and give it everything it needs, because it starts
blank and does **not** inherit this repository's conventions from your context:

- the worktree path and the branch;
- the issue and the spec section the change claims;
- the pull request number;
- that `pnpm verify` is already green, so it should not re-run suites;
- the specific claims you want checked against the code rather than against
  plausibility — every factual assertion the change makes about how something behaves.

Fan out more than one when the change has independent seams (schema, a rule, a surface):
one reader per seam, in one batch, each told what to ignore.

## 3. Act on it, then record it

- **Blockers get fixed**, and the fix is squashed into the commit that introduced the
  problem — not appended as "address review".
- **Disagree in writing** when you think a finding is wrong, with the evidence. A
  reviewer who was overruled with a reason is doing their job; one who was ignored is
  not.
- **Post the verdict on the pull request** — the findings, what you fixed, and what you
  did not and why. `gh pr comment <pr> --body-file <file>` (a heredoc with backticks and
  parentheses in it will fight the shell).

## 4. Report

Verdict, blocker count, what changed as a result, and anything the reviewer found that
belongs on the tracker rather than in this change — another lane's bug, a stale
comment, a convention nobody wrote down.

Extra arguments, if any, are constraints on this run: $@
