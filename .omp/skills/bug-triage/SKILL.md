---
name: bug-triage
description: Filing and triaging PlotRoom bugs — duplicate search, the severity rubric (bug:sev0–sev3), routing to the board, and escalation. Read when reporting a bug, an error, or a regression, or when triaging an untriaged bug label.
---

# Bug triage — every bug gets a severity the day it is filed

Bugs skip the idea stage and are triaged as they are filed. A bug keeps a
`bug*` label for its whole life — it is never relabeled `task` or `epic` —
and its severity rides the label as a suffix. Tracker mechanics (labels,
board, statuses) live in the `tracker` skill.

## 1. Search before you file

Most "new" bugs aren't:

```sh
gh issue list --state all --search "label:bug,bug:sev0,bug:sev1,bug:sev2,bug:sev3 <keywords>"
```

Search open **and** closed — a closed match means it was supposedly fixed:
check whether the fix landed (`Closes #N` PR, the commit) and whether this is
a regression of it (say so in the new issue, linking the old one).

- **Duplicate, open** → comment the new evidence on the existing issue
  (repro, logs, environment). Re-triage its severity upward if the new
  evidence warrants it. Do not file a second issue.
- **No match** → file.

## 2. Severity rubric

| Label      | Meaning                                                                    | Routing                                          |
| ---------- | -------------------------------------------------------------------------- | ------------------------------------------------ |
| `bug:sev0` | Data loss or corruption, security hole, product won't start, `main` is red | `To Do`, top; alert the operator **immediately** |
| `bug:sev1` | A core flow is broken with no workaround; other work is blocked            | `To Do`                                          |
| `bug:sev2` | Broken but a workaround exists; degraded behavior                          | `Backlog` (promoted at grooming)                 |
| `bug:sev3` | Cosmetic, papercut, minor annoyance                                        | `Backlog` (promoted at grooming)                 |

When torn between two severities, take the higher one — grooming can demote
with more information; nobody re-reads the backlog looking for underrated
sev2s. Spec principles sharpen the call: silent truncation, unproven
completion claims, or an isolation breach is never below `sev1`.

## 3. File it

Title: a plain sentence describing the wrong behavior, house style — state the
defect, not "fix X" ("A deleted session keeps its §7.1 rows and stays in
search").

Body:

```markdown
## Repro

1. …

## Expected / Actual

Expected: …
Actual: …

## Evidence

Logs, file:line references, screenshots, failing test — whatever was observed.

## Scope and suspicion

Affected packages/surfaces; suspected cause if any (marked as suspicion).
```

Then, in one pass (tracker skill): create with label `bug:sevN`, add to the
board, set status per the rubric. Never leave a bug you filed without a
severity — a plain `bug` label means _untriaged_ and is only for reports filed
by someone who could not run triage (e.g. from the GitHub UI).

## 4. Triaging an untriaged `bug`

For each open issue labeled plain `bug`: reproduce (or establish why not),
apply the rubric, swap `bug` for `bug:sevN`, route per the table. Grooming
(`/plotroom:groom`) sweeps these, but anyone meeting an untriaged bug may
triage it.

## 5. sev0 escalation

A `sev0` is not just a label: tell the operator the moment it is filed (in an
interactive session say it directly; a subagent raises it via `hub` to its
parent). If `main` is red, delivering the fix outranks all other in-flight
work.
