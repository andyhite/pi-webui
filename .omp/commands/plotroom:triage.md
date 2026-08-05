---
description: Triage a bug, error or idea — find the duplicate, then file it on the right lane
---

Triage this: $@

`skill://plotroom-tracker` has the board's shape and verbs; read it first. If the
argument is a bare issue number, triage that existing item instead of filing a new
one.

## 1. Find out whether it already exists — before writing anything

Search wide, then narrow. A duplicate filed twice costs more than the search:

```sh
env -u GH_TOKEN gh issue list --state all --limit 40 --search "<the distinctive words>" \
  --json number,title,state,labels,closedAt
```

Search the **symptom** and the **mechanism** separately (an error string, then the
function or table it comes from), and search closed issues too — a closed one that
describes this exactly is either a regression (say so, with the commit that fixed it)
or evidence the fix never shipped.

Then read the candidates as `issue://<n>` and decide, out loud:

- **duplicate** → comment the new evidence on the existing item (what you saw, where,
  and what makes it the same fact) and stop. Do not file.
- **regression** → new issue, referencing the old one and the commit that closed it.
- **new** → continue.

## 2. Establish it, do not guess it

An error message is not a diagnosis. Before filing, find the code:

```sh
cd ~/plotroom && git fetch origin --quiet
```

Read the failing path and name it — `path:line`, the function, the table, the
predicate. Say whether you reproduced it, and how, or that you did not. A report that
names the seam is a claimable item; one that quotes a stack trace is a research task
somebody has to redo.

Use `scout` for a file map you do not have. Do not fix anything: triage decides
_what_ the work is, not who does it or when.

## 3. File it where its files live

The lane is decided by **file ownership**, not by subject — `issue://112` is the
ownership cut. If the fix spans two lanes' files, say which lane owns the write and
list the other as a cross-track edge in the body; that is the one thing the map
cannot derive later.

```sh
env -u GH_TOKEN gh issue create --title "<what is wrong, not what to do about it>" \
  --label <bug|enhancement|documentation|decision|follow-up> --label track:<lane> \
  --body "$(cat <<'EOF'
<what happens, and what should happen instead — spec section if there is one>

**Where** `path:line` — the mechanism, not the symptom.

**Reproduce** the exact command or gesture, or "not reproduced: <why>".

**Scope** what the fix has to touch, and what it must not.
EOF
)"
```

Then put it on the board in `Backlog` with its `Track` set (commands in the tracker
skill), and **parent it** if it is a follow-up of landed work or a child of an epic —
an unparented follow-up reads as an orphan to the next reader.

Placement in a lane's queue and its dates are the operator's call. Say where you
think it goes and why (in front of what, because of what), and leave it in `Backlog`.

## 4. Report

One paragraph: what it is, the seam, duplicate or not (with the numbers you checked),
the lane and why that lane, and the one decision you left to me.
