---
description: Claim a track and work down its queue (lane name, or `list` for the lanes)
---

You own the PlotRoom lane `track:$1` — a serial queue with one owner. Work its next
item, then keep going down the lane.

**Read `skill://plotroom-tracker` first.** It is the only description of how this
board is shaped and how to move it; do not re-derive the field ids or invent a
status verb. Then read `AGENTS.md` in `~/plotroom` — it is binding and it is the
only description of the development cycle.

If `$1` is empty or `list`, print the lanes and stop:

```sh
env -u GH_TOKEN gh project field-list 1 --owner andyhite --format json \
  | jq -r '.fields[] | select(.name=="Track") | .options[].name'
```

## The lane

```sh
env -u GH_TOKEN gh project item-list 1 --owner andyhite --format json --limit 200 \
  | jq -r --arg t "$1" '[.items[] | select(.track == $t and .status != "Done")
      | select(((.labels // []) | index("epic")) == null)]
      | sort_by((.start // "9999"), .content.number)[]
      | "\(.status)\t#\(.content.number)\t\((.start // "-")[0:10])\t\(.content.title)"'
```

No rows means the lane name is wrong — print the lane list above and ask me rather
than guessing.

**Pick, and say which rule applied:**

1. Anything `In Progress` or `Review` on this lane wins: find its branch and
   worktree and continue that work. Never start something new beside it. If its
   branch is already identical to `origin/main`, the work landed and only the
   cleanup is left — finish that first (`skill://plotroom-land` covers it).
2. Otherwise the earliest-scheduled `To Do`.
3. Otherwise a `Backlog` item, and say the lane needed triage.

The query already drops `Done` items and `epic` containers. Read `issue://<n>`
before starting — cached, comments included, and the comments are where the real
state is. `issue://112` is this lane's boundary: the files it owns, its queue
order, and the cross-track overlaps you must not walk into. Other agents are
working other lanes right now.

## The cycle

`AGENTS.md` states it and wins on any conflict; `docs/development.md` is how to run and
prove the thing. The shape, so you can see the whole item before you start — each step
has a command when the step is worth one:

1. **Plan** — `/plotroom:plan <n>`: which spec section, which of the six shapes, which
   files, which rule, what proof. Cheap to argue with before any code exists.
2. **Claim** — status `In Progress` and a comment naming your branch, _before your
   first edit_.
3. **Worktree** — `git fetch origin`, then a branch off `origin/main` in a worktree
   of your own, then `pnpm install` in it.
4. **Implement** — one logical change per commit, Conventional Commits. Check as you
   go with the narrowest thing that covers the commit — `pnpm --filter <pkg>
typecheck`, `... test`, `... lint` for the package you touched. Never run the full
   `pnpm verify`, `pnpm build`, or the e2e suite inside this loop: `verify` repeats an
   uncached whole-repo Prettier pass and an uncached script suite on every call
   regardless of what changed, and e2e pays for a full build plus a Chromium boot —
   paying either cost per commit is the actual slowdown, not the checks themselves.
5. **Prove it — once, when implementation is done.** `pnpm verify`, plus
   `pnpm --filter @plotroom/web e2e` when you touched a surface it covers, plus
   `skill://plotroom-smoke` to actually exercise the change. Green verify proves
   nothing broke, not that the thing you built works. `skill://plotroom-land` runs
   `pnpm verify` (and e2e) again after the rebase — that is the only second run,
   because the rebase is what invalidates this one.
6. **Review** — `skill://plotroom-review`: a reader with fresh context, its verdict on
   the pull request, blockers fixed into the commits that caused them.
7. **Land** — `skill://plotroom-land`: rebase, pull request, merge it yourself when the
   checks are green, then close the issue, move the board, and remove the worktree.
   Nothing reaches `main` any other way.
8. **Next** — take the next item on this lane.

Found something that is not this item? `skill://plotroom-triage` files it on the right
lane rather than growing this change. Needed a convention nobody had written?
`skill://plotroom-decide` puts it where it belongs.

Use subagents inside the item wherever the work genuinely splits, and dispatch every
independent one in the same batch — never serialise slices that don't depend on each
other. Match the agent type to the work rather than reaching for the general-purpose
worker by default: `scout` to map files you do not know yet, `librarian` for a
vendor API's real behavior, `sonic` for a strictly mechanical fan-out (data
collection, uniform edits across many files). `plotroom-review` belongs to the Review
step (`skill://plotroom-review`) only — it judges a finished diff against an open pull
request and its verdict is recorded there; dispatching it here, before a pull request
exists, is a review nobody can find and the next reader has to redo. Only one of
these writes in your worktree — you.

A dispatched subagent that genuinely needs another dispatched subagent's mid-flight
finding messages it directly over `hub` rather than waiting for the whole batch to
return and you relaying between them: delivery is fire-and-forget, the recipient
sees it as a non-interrupting aside and can act on it at its own next turn, and
`await: true` blocks for a reply if the sender needs one before continuing.

Dispatch chooses an agent type, not a worker model — a subagent's model comes from
that agent's own configuration, never something this call picks.
Do not spend a heavier type on work a lighter one covers, and skip straight
to that type instead of routing everything through the general-purpose worker.
The same discipline applies to your own one-shot `completion()` calls:
`model="smol"` for a cheap, narrow lookup or classification, `model="slow"` for a
verification whose cost of missing something is high, and the session default for
everything in between. Reserve `slow` for the judgment calls this cycle actually
turns on — a plan's shape, a review's verdict — not routine lookups.

Anything another session needs to know goes on the issue: a shared seam you had to
touch, a bug you found (file it, with a kind label and a `Track`), a convention you
had to invent. There is no other channel between concurrent sessions.

If the lane's head is blocked by another track, say so on the issue and take the
next item you can actually do. Do not invent a step the cycle does not ask for, and
do not skip one because it seems small.

Extra arguments, if any, are constraints on this run: $@
