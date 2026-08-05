---
name: plotroom-tracker
description: How PlotRoom's work tracker is shaped and how to move it — the eleven GitHub Project lanes, the statuses, epic containers, and the exact commands that claim an item, hand it to review, record a blocker, or close it. Read this before changing any board state, and before starting work in ~/plotroom.
---

# The PlotRoom tracker

Work tracking lives **outside** the repository, deliberately: the repo holds prose
worth keeping, not a task list (`AGENTS.md` → "Documentation"). This skill is the
tracker's shape and its verbs. `AGENTS.md` is still the binding description of the
development cycle; this is only how to keep the board honest while you run it.

Unlike the subsystem notes that moved out of `.omp/skills/` into `docs/architecture/`
(`docs: keep the subsystem notes in docs/, not in .omp/skills`), this one earns its
place here: nothing in `AGENTS.md` or `.omp/RULES.md` names the tracker, so this
file's description line is the only thing that surfaces it before a session touches
the board, and every `plotroom:*` command addresses it as `skill://plotroom-tracker`.

- **Repo:** `andyhite/plotroom`, primary checkout `~/plotroom` (stays on `main`).
- **Board:** GitHub Project **#1**, owner `andyhite`.
- **The map:** issue **112** — lane ownership, queue order, cross-track edges,
  the schedule. Read it as `issue://112` (disk-cached, comments included) rather
  than shelling out to `gh issue view`.
- `gh` needs `env -u GH_TOKEN` in this environment; without it every call 401s.

## Vocabulary

| Thing                                       | Means                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Track** (`Track` field + `track:*` label) | a **serial queue with one owner at a time**. Tracks are cut by _file ownership_, so two lanes never write the same files. Eleven of them: `runtime`, `harness`, `agent-surface`, `instructions`, `approvals`, `collections`, `toolkit`, `canvas`, `settings`, `packaging`, `hygiene`, plus `unscheduled`. |
| **Status**                                  | `Backlog` → `To Do` → `In Progress` → `Review` → `Done`.                                                                                                                                                                                                                                                  |
| **`epic` label**                            | a **container, never picked**. It carries the span of its children. Any lane query must filter it out or a container gets handed out as work.                                                                                                                                                             |
| **`Track = unscheduled`**                   | not claimable: directional intentions (#55–#61), the refusal bundle (#117), recorded deferrals (#43), and the map itself.                                                                                                                                                                                 |
| **`Start` / `Target`**                      | dates; a sizing input, not a commitment. A stale date is the same failure as a stale status.                                                                                                                                                                                                              |

Never enumerate the lanes from memory — derive them:

```sh
env -u GH_TOKEN gh project field-list 1 --owner andyhite --format json \
  | jq -r '.fields[] | select(.name=="Track") | .options[].name'
```

## One read gives you the whole board

Custom fields arrive flattened and lowercased (`.track`, `.status`, `.start`,
`.target`), the issue is under `.content`, and there is no assignee field —
**who is on an item is the issue's comments and the worktree list, not the board.**

```sh
env -u GH_TOKEN gh project item-list 1 --owner andyhite --format json --limit 200 \
  | jq -r '[.items[] | select(.track == "runtime" and .status != "Done")
      | select(((.labels // []) | index("epic")) == null)]
      | sort_by((.start // "9999"), .content.number)[]
      | "\(.status)\t#\(.content.number)\t\((.start // "-")[0:10])\t\(.content.title)"'
```

Then read the item itself as `issue://<n>` — cached, and it carries the comments,
which are where the real state is (a lane's queue is often re-stated there after
something lands).

## Moving state — the four transitions

`AGENTS.md`: tracked state is only true if it is current, so **move it the moment
it changes**, not at the end. An item nobody moved reads to every other session as
work available, which is how two agents write the same change on two branches.

The ids below are constants of this project. A wrong id fails loudly rather than
writing the wrong thing; re-derive with `gh project field-list 1 --owner andyhite`.

```sh
PROJECT=PVT_kwHOAAESt84BfXoh
F_STATUS=PVTSSF_lAHOAAESt84BfXohzhZrAUM   # Backlog=0f062b37 To Do=3298d534
                                          # In Progress=23d64328 Review=747104e3 Done=601a9561
F_TRACK=PVTSSF_lAHOAAESt84BfXohzhZsO4Q    # runtime=ef86d031 harness=b7c491e3
                                          # agent-surface=d78aee16 instructions=5506cc66
                                          # approvals=d174110e collections=3773a42c
                                          # toolkit=6484ec0a canvas=be3b3c51
                                          # settings=300970b4 packaging=c4b99a89
                                          # hygiene=e42f0c74 unscheduled=3a798509
F_START=PVTF_lAHOAAESt84BfXohzhZsO4I
F_TARGET=PVTF_lAHOAAESt84BfXohzhZsO4M

pr_item() {  # pr_item <issue-number> -> project item id
  env -u GH_TOKEN gh project item-list 1 --owner andyhite --format json --limit 200 \
    | jq -er --argjson n "$1" '.items[] | select(.content.number == $n) | .id'
}
pr_status() {  # pr_status <issue-number> <option-id>
  env -u GH_TOKEN gh project item-edit --project-id "$PROJECT" --field-id "$F_STATUS" \
    --id "$(pr_item "$1")" --single-select-option-id "$2" >/dev/null && echo "#$1 moved"
}
pr_date() {  # pr_date <issue-number> <F_START|F_TARGET> <YYYY-MM-DD>
  env -u GH_TOKEN gh project item-edit --project-id "$PROJECT" --field-id "$2" \
    --id "$(pr_item "$1")" --date "$3" >/dev/null && echo "#$1 dated"
}
```

1. **Claim — before your first edit.** `pr_status <n> 23d64328` (In Progress), and
   comment the branch and worktree you will work in, so the next session finds your
   work instead of starting it again:
   ```sh
   env -u GH_TOKEN gh issue comment <n> --body "Claimed. Branch \`fix/<slug>\`, worktree \`../plotroom-fix-<slug>\`."
   ```
2. **Hand to review.** Open the pull request, then `pr_status <n> 747104e3` (Review).
   `Review` means _a pull request exists and is waiting on its checks or its reader_ —
   the review itself lives on the pull request, never on the issue and never in a
   session nobody else can read.
3. **Blocked, or scope changed.** Say it on the issue _the moment it is true_ — what
   blocks it, and which item or decision would unblock it — then take the next item
   you can actually do. Do not leave it `In Progress`.
4. **Landed.** A change lands only by its author merging its pull request, so `Done`
   means merged — never "the branch is ready". Close the issue with the commit sha,
   `pr_status <n> 601a9561`, then remove the worktree and the local branch; GitHub
   deletes the remote one. A task is not complete while its worktree exists.

Filing work you find on the way: `gh issue create` with a kind label
(`bug`/`feat`/`docs`/…), then put it on the board and set its `Track`:

```sh
env -u GH_TOKEN gh project item-add 1 --owner andyhite --url https://github.com/andyhite/plotroom/issues/<n>
pr_status <n> 0f062b37            # Backlog — inserting it into a lane's queue is the operator's call
env -u GH_TOKEN gh project item-edit --project-id "$PROJECT" --field-id "$F_TRACK" \
  --id "$(pr_item <n>)" --single-select-option-id <track-option-id>
```

## Lane invariants that are not on the board

- **One agent per lane, one branch per item, one worktree per branch, one writer.**
  A worktree you did not create belongs to another session: read it if you are
  reviewing it, never write to it.
- A fresh worktree needs its own install — `node_modules` is not shared:
  ```sh
  git fetch origin
  git worktree add ../plotroom-<type>-<slug> -b <type>/<slug> origin/main && cd $_ && pnpm install
  ```
  Branch from `origin/main` so you never need the primary checkout to start work.
- Where the map and the board disagree about order, **the board wins** and the map
  gets updated (it is prose and it lags).
- Issue 112 is the index, not work. Edit it when lane ownership or queue order
  actually changes — and prefer a comment over rewriting the body, so the history
  of why an order changed survives.

## Three grouping mechanisms, one job each

Settled deliberately, because the board once had two of them saying the same thing:

- **Sub-issues = containment.** What is part of what. A parent is exclusive: one
  issue, one parent. This is what gives an epic its progress bar and what the
  roadmap's epic spans are computed from.
- **Tracks = who works in parallel.** Cut by file ownership, not by subject, which
  is why a CI item can sit with the runtime work it collides with.
- **Milestones = what ships together.** A decision about a cut, orthogonal to both.
  Never named for a version — the version is derived from Conventional Commits at
  release time, and a milestone called `v0.1.0` is a second place that is decided.

A grouping that duplicates another is drift; when two surfaces can disagree about
one fact, retire one of them.

Kind labels are the fourth axis and every item carries exactly one: `bug`,
`documentation`, `decision`, `epic`, `follow-up`, `idea`. `Track` is retired —
sub-issue containment (epics) and milestones are the only grouping left.

## Scheduling and the roadmap

The project's **Roadmap** view draws `Start` → `Target`, grouped by `Track` — one
swimlane per lane. Two of its settings are UI-only and already set: the date-field
pair and _Group by_. `UpdateProjectV2ViewInput` cannot express them, so never try to
script that part; the dates are the only thing you write.

What the existing schedule assumes, and what a new window keeps:

- one agent per lane, lanes in parallel, **business days only**;
- durations **derived from each issue's stated scope** — a sizing input, never a
  commitment, and a duration you cannot justify from the issue body is a guess;
- an item starts no earlier than every cross-track edge it waits on ends, and no
  earlier than any lane mid-flight in its files has landed;
- **epic spans are computed from their children**, never written by hand;
- `unscheduled` items carry no dates on purpose;
- **a stale date is the same failure as a stale status** — an overrun gets re-dated
  or recorded, not ignored.

Scheduling decides _when_, never _whether_: filling a gap by promoting something out
of `Backlog`, reordering a lane, or dropping an item is the operator's call, and the
finding to report is that the lane cannot fill the window.

## Anomalies worth reporting whenever you look at the board

Cheap to check, and each one means some session's state is lying:

- two items `In Progress` on one lane (two agents in one serial queue);
- an `In Progress` or `Review` item with **no worktree** for its branch;
- a worktree whose branch is **identical to `origin/main`**
  (`git rev-list --left-right --count origin/main...<branch>` → `0 0`): the work
  landed and the cleanup did not happen;
- a closed issue still in a live column, or an open item in `Done`;
- an open pull request whose checks are green and whose review is answered and which
  nobody merged — the author merges their own work, so nobody else is coming;
- an item in `Review` with no pull request, or an open pull request whose item is not
  in `Review`;
- a `Target` already in the past;
- a lane head blocked by another track — check the cross-track edge list on
  `issue://112` before calling anything blocked.

Correct what you can (a status is one call) and report the rest on the item.
