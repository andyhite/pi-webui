---
description: Groom the backlog — fix what the board has wrong, propose what needs a decision
---

Groom the PlotRoom board. `skill://plotroom-tracker` has its shape, its ids and its
verbs; read it first. Lanes to groom, if any were named: $@ — otherwise all of them.

Grooming is **hygiene, not planning.** You correct facts and you file what is
missing. You do not reorder a lane's queue, re-date a scheduled item, or promote
anything out of `Backlog` — those are the operator's, and you report them as
proposals instead.

## 1. Read everything once

```sh
env -u GH_TOKEN gh project item-list 1 --owner andyhite --format json --limit 200 > /tmp/board.json
env -u GH_TOKEN gh issue list --state open --limit 300 --json number,title,labels,milestone,createdAt,updatedAt > /tmp/issues.json
cd ~/plotroom && git fetch origin --quiet && git worktree list
```

Then `issue://112` for lane ownership, queue order and the cross-track edges.

## 2. Find what is actually wrong

Work from the data, not from memory. Report each finding as `#n — what — the fix`.

**Off the board or unclassified**

- an open issue that is not a board item at all (`gh issue list` minus `/tmp/board.json`);
- a board item with no `Track` (or `Track = unscheduled` that is not one of the
  deliberate exceptions on the map: #43, #55–#61, #117, #112);
- an item with no kind label (`bug`, `documentation`, `decision`, `epic`,
  `follow-up`, `idea`).

**Containment**

- an `epic` with no children, or a child whose parent is not the epic its lane says;
- an epic whose span does not cover its children's dates (epic spans are computed
  from children, so the children are the truth);
- a follow-up filed out of landed work with **no parent** — those read as orphans to
  the next reader and should be parented rather than left to guess.

**State that cannot be true**

- a closed issue in a live column, or an open item in `Done`;
- two items `In Progress` on one lane;
- an `In Progress`/`Review` item with no worktree, or a worktree whose branch is
  identical to `origin/main` (landed, never cleaned up);
- a `Target` in the past on something not `Done`;
- a scheduled item (`To Do`/`In Progress`) missing `Start` or `Target`.

**Duplication and rot**

- two items describing the same work — say which is the survivor and why, and close
  the other _as a duplicate referencing it_, never silently;
- an item whose body was answered by something that has since landed: verify against
  `main` before proposing a close, and quote the commit;
- an item blocked on a decision nobody has been asked for — name the decision and
  who owes it.

## 3. Fix the mechanical ones, propose the rest

Apply directly: a missing or disagreeing `Track`/label, a wrong `Status` for a closed
or open issue, a missing parent that the map already implies, adding an off-board
issue to the board in `Backlog`. Each of these is one fact with one right answer.

Propose, do not apply: closing anything, merging duplicates, changing dates, moving
an item between lanes, inserting into a queue, or promoting out of `Backlog`. Give me
the one-line reason and the exact command you would run.

## 4. Report

Counts first: items read, findings by category, fixes applied, proposals waiting on
me. Then the proposals, each with its command. Then anything the map itself now gets
wrong — grooming is when that becomes visible, and a comment on `issue://112` is
where it goes.
