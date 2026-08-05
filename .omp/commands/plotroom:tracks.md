---
description: Report what is next on every lane, and what the board is lying about
---

Report what is next on the PlotRoom lanes. **Read-only: claim nothing, edit
nothing, start nothing** — including the board.

`skill://plotroom-tracker` has the board's shape and the anomaly list. Two reads
are enough for this report.

## The board

```sh
env -u GH_TOKEN gh project item-list 1 --owner andyhite --format json --limit 200 \
  | jq -r '[.items[] | select(.track != null and .track != "unscheduled" and .status != "Done")
      | select(((.labels // []) | index("epic")) == null)]
      | sort_by(.track, (.start // "9999"), .content.number)
      | group_by(.track)[]
      | "\(.[0].track): " + ([.[] | "#\(.content.number)[\(.status[0:4])] \((.start // "-")[0:10])"] | join("  "))'
```

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

One row per lane: lane, next item, its board state, its window. Next on a lane is
its first entry — unless something on that lane is `In Progress` or `Review`, which
wins, because it means an agent is already mid-flight there.

Then flag only what is actually wrong:

- two items `In Progress` on one lane;
- an `In Progress`/`Review` item with no worktree, or a worktree with no live item;
- a landed branch (`0 0` above) whose worktree still exists;
- a closed issue in a live column, or an open item in `Done`;
- a `Target` already past;
- a lane head blocked by another track — the cross-track edges are on `issue://112`;
  read it before calling anything blocked.

Say which lanes are startable from a standing start today, and which are waiting on
another lane's landing. Nothing else.

Narrow to these lanes if any were named: $@
