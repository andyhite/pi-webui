---
description: Report what is next on every epic, and what the board is lying about
---

Report what is next on the PlotRoom epics. **Read-only: claim nothing, edit
nothing, start nothing** — including the board.

`skill://plotroom-tracker` has the board's shape and the anomaly list. A few reads
are enough for this report.

## The epics

```sh
env -u GH_TOKEN gh issue list --state open --label epic --limit 50 --json number,title
env -u GH_TOKEN gh project item-list 1 --owner andyhite --format json --limit 250 > /tmp/board.json
```

For each open epic, its children:

```sh
env -u GH_TOKEN gh api graphql -f query='
query($n: Int!) {
  repository(owner:"andyhite", name:"plotroom") {
    issue(number: $n) {
      subIssuesSummary { total completed }
      subIssues(first: 50) { nodes { number title state } }
    }
  }
}' -F n=<epic-number>
```

Cross-reference each child's number against `/tmp/board.json` for `Status`,
`Start`/`Target`.

## Who is actually mid-flight

The board has no assignee field, so a claim is a worktree plus a comment. This is
local and free, and it is what catches the drift the board cannot show:

```sh
cd ~/plotroom && git fetch origin --quiet
git worktree list
for b in $(git for-each-ref --format='%(refname:short)' refs/heads | grep -v '^main$'); do
  printf '%s\t%s\n' "$b" "$(git rev-list --left-right --count origin/main...$b)"
done
```

`0 0` means the branch is identical to `origin/main`: it landed, and its worktree
and branch were never removed.

## Report

One row per epic: epic, next item, its board state, its window. Next in an epic is
its first open child in the order the epic's own body states — unless something in
it is `In Progress` or `Review`, which wins, because it means an agent is already
mid-flight there.

Then flag only what is actually wrong:

- two items `In Progress` under one epic;
- an `In Progress`/`Review` item with no worktree, or a worktree with no live item;
- a landed branch (`0 0` above) whose worktree still exists;
- a closed issue in a live column, or an open item in `Done`;
- a `Target` already past;
- an epic with no children at all, or whose own body names no order for more than
  one open child;
- an epic blocked by another epic — read both bodies for `Blocked by`/`Related to`
  before calling anything blocked.

Say which epics are startable from a standing start today, and which are waiting on
another epic's landing. Nothing else.

Narrow to these epics if any were named: $@
