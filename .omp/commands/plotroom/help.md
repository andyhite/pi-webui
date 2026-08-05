---
description: Explain the workflow — every command, skill, agent, and doc, and when to use which
---

Orient me. If "$1" names a specific command, skill, or agent, skip the
overview and explain that one in depth instead: read its file, describe its
argument, where it sits in the lifecycle, which skills it reads, what it
leaves behind (board moves, branches, PRs), and show one worked invocation.

Ground everything in the live tree, never from memory: list
`.omp/commands/plotroom/*.md` and take each command's `description`
frontmatter; list `.omp/skills/plotroom/*/SKILL.md` and `.omp/agents/*.md`
the same way; read the Documentation table in `AGENTS.md`. If anything this
file implies disagrees with what is on disk, disk wins — present what exists.

Present, compactly — tables over prose, one screen if you can:

1. **The lifecycle in one breath.** Ideas are recorded cheaply (`/record`),
   groomed into a task or an epic — or rejected (`/groom`), delivered
   (`/work <issue>` for a task or bug, `/orchestrate <epic>` for an epic),
   and land on `main` only through a PR that **I** merge — the merge is the
   approval. Bugs enter through `/triage` with a severity label and skip the
   idea stage. `/report` snapshots the board without moving anything.
2. **Commands.** One row each: command, argument, what it does (its own
   description), and the moment you'd reach for it.
3. **Skills.** The operating manual behind the commands: which skill backs
   which command, and the ones read mid-task regardless of entry point
   (`tracker` for anything board-shaped, `worktree` before creating or
   removing one, `verification` before running checks, `stacked-prs` when an
   epic track chains).
4. **Project agents.** What `planner`, `qa`, and `issue-worker` each do and
   who dispatches them.
5. **Documentation.** The `AGENTS.md` "When you need… → Read" index, with
   `docs/product-spec.md` called out as the document every change is judged
   against.
6. **The rules that bite.** From `.omp/RULES.md`, the handful that undo a
   session when missed: one issue, one branch, one worktree, one writer;
   claim before the first edit and keep the board current; agents never
   merge; a task is not done while its worktree exists.

Close with the one-line default: unsure where to start? `/report` to see the
board, then `/work` the top of `To Do`.
