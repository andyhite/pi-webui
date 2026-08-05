---
name: tracker
description: The single source of truth for PlotRoom work tracking — issue lifecycle, label vocabulary, board statuses and IDs, epic status derivation, and the exact gh/GraphQL recipes for every transition. Read before creating, relabeling, or moving any issue.
---

# Tracker — GitHub Issues + the PlotRoom project board

Everything that is work is a GitHub issue in `andyhite/plotroom`, on project
board **PlotRoom** (`#1`, owner `andyhite`). The board is the only shared
memory between concurrent sessions: **move state the moment it changes**, and
trust the board over your assumptions — an item nobody moved reads as work
available.

## Constants

| Thing                | Value                            |
| -------------------- | -------------------------------- |
| Repository           | `andyhite/plotroom`              |
| Project              | `#1` (owner `andyhite`)          |
| Project node ID      | `PVT_kwHOAAESt84BfXoh`           |
| Status field ID      | `PVTSSF_lAHOAAESt84BfXohzhZrAUM` |
| `Backlog` option     | `dad26564`                       |
| `To Do` option       | `7fdf3eaa`                       |
| `In Progress` option | `ae0035a4`                       |
| `Review` option      | `8c670574`                       |
| `Done` option        | `0253d807`                       |
| `Rejected` option    | `011dcc12`                       |

If an ID ever fails to resolve, re-derive it (`gh project field-list 1 --owner
andyhite --format json`) and update this table — never guess.

## Labels

| Label                   | Meaning                                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| `idea`                  | Recorded intention, minimal detail. Awaits grooming.                      |
| `epic`                  | Large multi-task effort. Never actionable itself; broken into sub-issues. |
| `task`                  | Small, directly actionable unit: one PR, one worktree.                    |
| `bug`                   | Untriaged bug report — triage replaces it with a severity label.          |
| `bug:sev0` … `bug:sev3` | Triaged bug; severity rubric in the `bug-triage` skill.                   |

Exactly one of these per issue. Ideas become epics or tasks at grooming; bugs
keep a `bug*` label for life and are **never** relabeled `task` or `epic`.

To list all bugs regardless of triage state (search commas are OR):

```sh
gh issue list --search "label:bug,bug:sev0,bug:sev1,bug:sev2,bug:sev3" --state open
```

## Statuses and who moves them

| Status        | Meaning                                          | Entered when                                                                                         |
| ------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `Backlog`     | Captured, not committed to                       | Idea recorded; epic accepted; sev2/sev3 bug filed                                                    |
| `To Do`       | Committed, next up, ordered by priority          | Task accepted at grooming; epic breakdown lands; sev0/sev1 bug filed; sev2/sev3 promoted at grooming |
| `In Progress` | Actively being worked in a worktree              | A session claims it — **before its first edit**                                                      |
| `Review`      | PR open, `verify` green, waiting on the operator | The PR opens. An operator comment on the PR is a change request → falls back to `In Progress`        |
| `Done`        | Operator-merged to `main`, worktree cleaned up   | The operator merges the PR — the merge **is** the approval. `Done` after merge **and** cleanup       |
| `Rejected`    | Groomed and declined                             | Grooming rejects an idea; issue is closed as not planned                                             |

Lifecycle: `idea → Backlog` → grooming → (`Rejected` | `task → To Do` |
`epic → Backlog` → breakdown → subtasks `To Do`) → `In Progress` → `Review` →
`Done`. Bugs skip the idea stage: triage routes sev0/sev1 straight to `To Do`
and sev2/sev3 to `Backlog`.

Chained epic subtasks ship as **stacked PRs** — one layer per subtask, with
each layer's issue moving through `Review`/`Done` exactly as above as its
layer PR opens and merges; see `skill://stacked-prs`.

## Epic status is derived from its subtasks

An epic never moves on its own. Recompute after every subtask transition:

1. All subtasks `Done` **and** epic integration verification passed → `Done`
   (close the epic).
2. Else, all subtasks at `Review` or `Done` → `Review`.
3. Else, any subtask at `In Progress`, `Review`, or `Done` → `In Progress`.
4. Else, any subtask at `To Do` → `To Do`.
5. Else → `Backlog`.

This is bidirectional: a subtask falling back (e.g. `Review → In Progress` on
requested changes) pulls the epic back with it.

## Recipes

### Create an issue

```sh
gh issue create --title "<title>" --label idea --body "<body>"
```

Titles are plain descriptive sentences, lower-key, no prefixes (existing style:
"A deleted session keeps its §7.1 rows and stays in search").

### Add it to the board and set status

```sh
# item-add is idempotent and prints the item id
ITEM=$(gh project item-add 1 --owner andyhite --url <issue-url> --format json --jq '.id')
gh project item-edit --id "$ITEM" --project-id PVT_kwHOAAESt84BfXoh \
  --field-id PVTSSF_lAHOAAESt84BfXohzhZrAUM --single-select-option-id <OPTION_ID>
```

### Find the board item for an existing issue

```sh
ITEM=$(gh api graphql -f query='query{repository(owner:"andyhite",name:"plotroom"){
  issue(number:<N>){projectItems(first:10){nodes{id project{number}}}}}}' \
  --jq '.data.repository.issue.projectItems.nodes[] | select(.project.number==1) | .id')
```

### Read an issue's current status

```sh
gh api graphql -f query='query{repository(owner:"andyhite",name:"plotroom"){
  issue(number:<N>){projectItems(first:10){nodes{project{number}
    fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}'
```

### Link a task to its epic (sub-issue)

```sh
PARENT=$(gh issue view <epic-number> --json id --jq .id)
CHILD=$(gh issue view <task-number> --json id --jq .id)
gh api graphql -f query="mutation{addSubIssue(input:{issueId:\"$PARENT\",subIssueId:\"$CHILD\"}){issue{number}}}"
```

List an epic's subtasks with statuses in one query:

```sh
gh api graphql -f query='query{repository(owner:"andyhite",name:"plotroom"){
  issue(number:<EPIC>){subIssues(first:50){nodes{number title state labels(first:5){nodes{name}}
    projectItems(first:5){nodes{project{number}
      fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}}}'
```

### Reject an idea

```sh
gh issue close <N> --reason "not planned" --comment "<why, in one or two sentences>"
# then set the board item's status to Rejected (011dcc12)
```

### Relabel at grooming

```sh
gh issue edit <N> --remove-label idea --add-label task   # or epic
gh issue edit <N> --body-file <respecced-body.md>
```

### Record a blocker

Blockers live on the issue, not in your head:

```sh
gh issue comment <N> --body "Blocked: <what, since when, what would unblock it>"
```

## Hazards

- **Never edit the Status field's options without carrying over each existing
  option's `id`.** `updateProjectV2Field` _replaces_ the option list; an option
  submitted without its current `id` becomes a new option and every item's
  value for the old one is silently cleared. (Recovery exists — each issue's
  timeline keeps `ProjectV2ItemStatusChangedEvent` — but do not get there.)
- `gh project item-edit` needs the **item** ID (`PVTI_…`), not the issue ID.
- A PR body containing `Closes #N` closes the issue on merge, but does **not**
  move the board status — set `Done` explicitly after merge and cleanup.
- Exactly one type label per issue: adding `task` means removing `idea`;
  adding `bug:sevN` means removing `bug`.
