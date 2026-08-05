---
description: Plan a scheduling window across the epics — propose dates, then write them on confirmation
---

Plan the window: $@ — a date range (`2026-08-10..2026-08-21`), a duration
(`two weeks from Monday`), or nothing, which means the next ten business days.

`skill://plotroom-tracker` has the board's shape and the `Start`/`Target` verbs.
There is no separate index issue anymore: read each epic (`issue://<n>`) for its own
stated scope, queue order, and any `Blocked by`/`Related to` it names.

**Scheduling decides _when_, never _whether_.** You are laying out work that is
already ordered — you do not reorder an epic's queue, drop an item, or promote
something out of `Backlog` to fill a gap. If an epic cannot fill the window, that is
the finding.

## 1. Read the board and the epics

```sh
env -u GH_TOKEN gh issue list --state open --label epic --limit 50 --json number,title
env -u GH_TOKEN gh project item-list 1 --owner andyhite --format json --limit 250 > /tmp/board.json
```

For each epic, in its own stated order: the item, its status, its current
`Start`/`Target`, and whether it is blocked by another epic. Anything `In Progress`
is already running and keeps its dates unless it has overrun — an overrun is a
finding, not a re-plan.

## 2. Lay out the window

The assumptions the existing schedule was built on, which you keep unless I say
otherwise:

- **however many agents are actually free run in parallel, one per epic at a time** —
  there is no fixed lane count anymore, so say how many you assumed and why;
- durations are **derived from each issue's stated scope** — read the issue; a
  duration you cannot justify from its body is a guess, and you say so;
- an item **starts no earlier than every cross-epic edge it waits on ends** (each
  epic's own `Blocked by`/`Related to` notes are the source now — there is no
  separate edge list);
- an item whose files another epic is mid-flight in waits for that landing, even
  without a recorded edge — **epics no longer partition files the way tracks did**,
  so check `git worktree list` and open pull requests, not just the epic bodies;
- **epic spans are computed from their children**, never set by hand;
- an epic whose work is gated on an undecided decision, or that is explicitly `idea`
  (beyond-MVP) work, carries **no dates**, deliberately;
- an epic with a blocked head that has a clean self-contained child behind it is
  worth calling out as a **spare-agent pickup** rather than reordered.

Produce, before writing anything:

- one row per epic — item, dates, why that duration, what it waits on;
- the **critical path** through the window and what ends it;
- epics that **cannot fill** the window, and why (blocked, drained, or gated on a
  decision I owe);
- items already dated that this window **contradicts**, with the old and new dates.

## 3. Write it, once I confirm

Dates only — never a status, never a queue order, never a label:

```sh
pr_date <n> "$F_START"  <YYYY-MM-DD>
pr_date <n> "$F_TARGET" <YYYY-MM-DD>
```

Then record the window as a comment on **each epic it touches** — what changed, what
it assumed, and which epics are startable — so no single document silently drifts
from the board the way the old track map did.

Milestones are a **different question** ("what ships together") and are not a
sprint: only touch one if I ask.

**The old Roadmap view's "Group by Track" has nothing to group by anymore** — Track
is deleted. If you want a swimlane view back, that is a new decision (a new
single-select field, most likely mirroring parent epic), not something this command
invents on its own; say so and ask rather than adding a field to make the view work.

## 4. Report

The epic table, the critical path, the epics that cannot fill the window, and the
dates you wrote. Then the one thing most likely to make this plan wrong.
