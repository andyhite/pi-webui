---
description: Groom the backlog — fix what the board has wrong, propose what needs a decision
---

Groom the PlotRoom board. `skill://plotroom-tracker` has its shape, its ids and its
verbs; read it first. Epics to groom, if any were named: $@ — otherwise all of them.

Grooming is **hygiene, not planning.** You correct facts and you file what is
missing. You do not reorder an epic's queue, re-date a scheduled item, or promote
anything out of `Backlog` — those are the operator's, and you report them as
proposals instead.

## 1. Read everything once

```sh
env -u GH_TOKEN gh project item-list 1 --owner andyhite --format json --limit 250 > /tmp/board.json
env -u GH_TOKEN gh issue list --state open --limit 300 --json number,title,labels,milestone,createdAt,updatedAt > /tmp/issues.json
env -u GH_TOKEN gh issue list --state open --label epic --limit 50 --json number,title > /tmp/epics.json
cd ~/plotroom && git fetch origin --quiet && git worktree list
```

Then read each epic (`issue://<n>`) for its own stated scope, queue order, and any
`Blocked by`/`Related to` it names — an epic's body is its own map now; there is no
separate index issue.

## 2. Find what is actually wrong

Work from the data, not from memory. Report each finding as `#n — what — the fix`.

**Off the board or unclassified**

- an open issue that is not a board item at all (`gh issue list` minus `/tmp/board.json`);
- an item with no kind label (`bug`, `documentation`, `decision`, `epic`, `follow-up`,
  `idea`) — exactly one, never zero, never two;
- a non-`bug` issue with **no parent epic** — everything except a bug gets one
  (`skill://plotroom-tracker` → "Deliberately unparented" is the short exception
  list; anything else orphaned is a finding).

**Containment**

- an `epic` with no children, or a child whose parent is not the epic its own body
  says it belongs to;
- an epic that is itself parented — a parent is never parented;
- a follow-up filed out of landed work with **no parent** — those read as orphans to
  the next reader and should be parented rather than left to guess;
- two epics whose bodies claim overlapping files with neither naming the other —
  the old `track:*` partition is gone, so this collision is no longer structurally
  impossible.

**State that cannot be true**

- a closed issue in a live column, or an open item in `Done`;
- two items `In Progress` under one epic;
- an `In Progress`/`Review` item with no worktree, or a worktree whose branch is
  identical to `origin/main` (landed, never cleaned up);
- a `Target` in the past on something not `Done`.

**Duplication and rot**

- two items describing the same work — say which is the survivor and why, and close
  the other _as a duplicate referencing it_, never silently;
- an item whose body was answered by something that has since landed: verify against
  `main` before proposing a close, and quote the commit;
- an item blocked on a decision nobody has been asked for — name the decision and
  who owes it.

## 3. Fix the mechanical ones, propose the rest

Apply directly: a missing or wrong kind label, a wrong `Status` for a closed or open
issue, a missing parent that an epic's own body already implies, adding an off-board
issue to the board in `Backlog`. Each of these is one fact with one right answer.

Propose, do not apply: closing anything, merging duplicates, changing dates, moving
an item between epics, inserting into a queue, or promoting out of `Backlog`. Give me
the one-line reason and the exact command you would run.

## 4. Report

Counts first: items read, findings by category, fixes applied, proposals waiting on
me. Then the proposals, each with its command. Then anything an epic's own body now
gets wrong about its children — grooming is when that becomes visible, and a comment
on the epic itself is where the correction goes.
