---
description: Plan a sprint window across the lanes — propose dates, then write them on confirmation
---

Plan the window: $@ — a date range (`2026-08-10..2026-08-21`), a duration
(`two weeks from Monday`), or nothing, which means the next ten business days.

`skill://plotroom-tracker` has the board's shape, the `Start`/`Target` verbs and the
scheduling rules the roadmap already assumes. Read it, then `issue://112` for lane
ownership, queue order, the cross-track edges and the current schedule.

**Scheduling decides _when_, never _whether_.** You are laying out work that is
already ordered — you do not reorder a lane, drop an item, or promote something out
of `Backlog` to fill a gap. If a lane cannot fill the window, that is the finding.

## 1. Read the board and the calendar

```sh
env -u GH_TOKEN gh project item-list 1 --owner andyhite --format json --limit 200 > /tmp/board.json
```

For each lane, in queue order: the item, its status, its current `Start`/`Target`,
and whether it is blocked by another lane. Anything `In Progress` is already running
and keeps its dates unless it has overrun — an overrun is a finding, not a re-plan.

## 2. Lay out the window

The assumptions the existing schedule was built on, which you keep unless I say
otherwise:

- **one agent per lane, lanes in parallel, business days only** (no weekends);
- durations are **derived from each issue's stated scope** — read the issue; a
  duration you cannot justify from its body is a guess, and you say so;
- an item **starts no earlier than every cross-track edge it waits on ends**
  (`issue://112` lists them; #81 waiting on #74 is the shape);
- an item whose files another lane is mid-flight in waits for that landing, even
  without a recorded edge — one writer per file;
- **epic spans are computed from their children**, never set by hand;
- `Track = unscheduled` items carry **no dates**, deliberately;
- a lane with a blocked head that has a clean self-contained item behind it is worth
  calling out as a **spare-agent pickup** rather than reordered.

Produce, before writing anything:

- one row per lane — item, dates, why that duration, what it waits on;
- the **critical path** through the window and what ends it;
- lanes that **cannot fill** the window, and why (blocked, drained, or gated on a
  decision I owe);
- items already dated that this window **contradicts**, with the old and new dates.

## 3. Write it, once I confirm

Dates only — never a status, never a queue order, never a label:

```sh
pr_date <n> "$F_START"  <YYYY-MM-DD>
pr_date <n> "$F_TARGET" <YYYY-MM-DD>
```

Then record the window as a comment on `issue://112` — what changed, what it assumed,
and which lanes are startable — so the map does not silently drift from the board. A
schedule nobody wrote down is invisible to every other session.

Milestones are a **different question** ("what ships together") and are not a sprint:
only touch one if I ask.

## 4. Report

The lane table, the critical path, the lanes that cannot fill the window, and the
dates you wrote. Then the one thing most likely to make this plan wrong.
