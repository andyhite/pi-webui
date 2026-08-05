---
name: plotroom-tracker
description: How PlotRoom's work tracker is shaped and how to move it — epics, statuses, and the exact commands that claim an item, hand it to review, record a blocker, or close it. Read this before changing any board state, and before starting work in ~/plotroom.
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
- **The unit of work you claim is an epic**, not a track. There used to be a `Track`
  field and eleven `track:*` labels cutting the board into serial queues by file
  ownership; both are retired and deleted. **The epic is the track now** — pick an
  open `epic`-labelled issue, work down its children, and it carries everything a
  track used to: what it's about, the order to take its children in, and (when it
  matters) which other epics it must not collide with.
- `gh` needs `env -u GH_TOKEN` in this environment; without it every call 401s.

## Vocabulary

| Thing                  | Means                                                                                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Epic**               | a **container, never picked**. Labelled `epic`, has children (sub-issues), and never has a parent of its own. It carries the span of its children and — in its own body — the scope, the order to take them in, and any other epic it depends on or collides with.                   |
| **Status**             | `Backlog` → `To Do` → `In Progress` → `Review` → `Done`.                                                                                                                                                                                                                             |
| **Kind label**         | exactly one per issue: `bug`, `documentation`, `decision`, `epic`, `follow-up`, `idea`. A `bug` may be left with no parent; everything else gets one — an epic, if it is feature or follow-up work — with the small set of deliberate exceptions in "Deliberately unparented" below. |
| **`idea` label**       | spec §13's recorded intentions, or anything else deliberately deferred pending a decision. Never promoted by drift — only by an explicit operator decision.                                                                                                                          |
| **`Start` / `Target`** | dates; a sizing input, not a commitment. A stale date is the same failure as a stale status.                                                                                                                                                                                         |

Never enumerate the epics from memory — derive them:

```sh
env -u GH_TOKEN gh issue list --state open --label epic --limit 50 --json number,title
```

## One read gives you the whole board

```sh
env -u GH_TOKEN gh project item-list 1 --owner andyhite --format json --limit 250 > /tmp/board.json
```

Custom fields arrive flattened and lowercased (`.status`, `.start`, `.target`), the
issue is under `.content`, and there is no assignee field, no parent, and no epic
membership — **containment is not in this JSON.** For a given epic's children, ask
GitHub directly:

```sh
epic_children() {  # epic_children <epic-number>
  env -u GH_TOKEN gh api graphql -f query='
query($n: Int!) {
  repository(owner:"andyhite", name:"plotroom") {
    issue(number: $n) {
      subIssuesSummary { total completed }
      subIssues(first: 50) { nodes { number title state } }
    }
  }
}' -F n="$1"
}
```

Cross-reference the numbers it returns against `/tmp/board.json` for `Status`,
`Start`/`Target`. Then read the epic itself as `issue://<n>` — cached, and it carries
the comments, which are where the real state is (an epic's queue is often re-stated
there after something lands).

**An epic's body is its own map.** Most already state a "Queue, in intended order"
or a "Tracks" list of children with the order to take them in, and name what they
are `Blocked by` or `Related to` when another epic matters. If an epic you are about
to work does not say this and it has more than one open child, that is a grooming
finding, not something to guess past.

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
F_START=PVTF_lAHOAAESt84BfXohzhZsO4I
F_TARGET=PVTF_lAHOAAESt84BfXohzhZsO4M

pr_item() {  # pr_item <issue-number> -> project item id
  env -u GH_TOKEN gh project item-list 1 --owner andyhite --format json --limit 250 \
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
issue_id() {  # issue_id <issue-number> -> node id
  env -u GH_TOKEN gh api graphql -f query='
query($n: Int!) { repository(owner:"andyhite", name:"plotroom") { issue(number:$n) { id } } }' \
    -F n="$1" -q .data.repository.issue.id
}
parent_issue() {  # parent_issue <child-number> <epic-number>
  env -u GH_TOKEN gh api graphql -f query='
mutation($p: ID!, $c: ID!) { addSubIssue(input: {issueId: $p, subIssueId: $c}) { subIssue { number } } }' \
    -f p="$(issue_id "$2")" -f c="$(issue_id "$1")"
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
(`bug`/`documentation`/`decision`/`follow-up`), then put it on the board and — unless
it is a `bug` — parent it under the right epic:

```sh
env -u GH_TOKEN gh project item-add 1 --owner andyhite --url https://github.com/andyhite/plotroom/issues/<n>
pr_status <n> 0f062b37            # Backlog — inserting it into an epic's queue is the operator's call
parent_issue <n> <epic-number>
```

## Lane invariants that are not on the board

The old `track:*` scheme guaranteed something epics do not: **eleven lanes cut by
file ownership, so two lanes never wrote the same files.** Epics are cut by roadmap
cohesion instead — two different epics can and do touch `packages/ui`, for instance
(the toolkit epic and the canvas epic both do). That guarantee is gone, and nothing
replaces it structurally. What takes its place is discipline, not a partition:

- **Before starting an epic's next item, check what else is actually in flight.**
  `git worktree list` plus `gh pr list --state open` tells you which files are
  already claimed by another session, epic or not — the check that used to be
  implicit in "this is my lane" is now explicit and manual.
- **An epic that knows it collides with another says so in its own body** (`Related:`,
  `Blocked by:`) — read it before you start, and add the note yourself if you find a
  collision nobody wrote down.
- **One agent per epic at a time is still the default courtesy**, even though nothing
  enforces it: two agents in one epic's children is the same failure a doubled lane
  used to be, just without the board catching it for you.
- A worktree you did not create belongs to another session: read it if you are
  reviewing it, never write to it.
- A fresh worktree needs its own install — `node_modules` is not shared:
  ```sh
  git fetch origin
  git worktree add ../plotroom-<type>-<slug> -b <type>/<slug> origin/main && cd $_ && pnpm install
  ```
  Branch from `origin/main` so you never need the primary checkout to start work.

## Two grouping mechanisms, one job each

Settled deliberately, because the board once had three of them saying overlapping
things — `Track` was the third, and it is retired:

- **Sub-issues = containment.** What is part of what. A parent is exclusive: one
  issue, one parent, and a parent is never itself parented. This is what gives an
  epic its progress bar and what any roadmap span is computed from.
- **Milestones = what ships together.** A decision about a cut, orthogonal to
  containment. Never named for a version — the version is derived from Conventional
  Commits at release time, and a milestone called `v0.1.0` is a second place that is
  decided.

A grouping that duplicates another is drift; when two surfaces can disagree about
one fact, retire one of them — which is exactly what happened to `Track`: the field
and the eleven `track:*` labels said the same thing sub-issue containment already
said, once every open issue had a parent epic.

## Deliberately unparented

Everything gets a parent epic except:

- **Bugs.** A `bug`-labelled issue may stay unparented; it may also be parented to an
  epic when it clearly belongs to one's story. Either is fine.
- **A handful of process/history issues** that predate epics entirely and describe a
  decision about the tracker itself rather than product work (e.g. the old track map,
  closed).

Nothing else. If you find a `follow-up`, `documentation`, `decision`, or `idea` issue
with no parent, that is a grooming finding: name the epic it belongs to, or — if none
fits — say so and propose a new one rather than leaving it orphaned.

## Anomalies worth reporting whenever you look at the board

Cheap to check, and each one means some session's state is lying:

- two items `In Progress` under one epic (two agents in what should be one queue);
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
- an epic with no children, or a child whose parent is not the epic its own body says;
- a non-`bug` issue with no parent at all;
- two epics whose bodies claim the same files with neither naming the other.

Correct what you can (a status is one call) and report the rest on the item.
