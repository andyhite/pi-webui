---
description: This is a pnpm workspace — npm, yarn, and npx corrupt the lockfile and bypass pinned versions
condition: '\bnpm\s+(install|i\b|ci\b|add|run|exec)|\byarn\s+(add|install|run)|\bnpx\s'
scope: tool
interruptMode: tool-only
---

This repository is a **pnpm 9 workspace** (`packageManager` is pinned):

- `npm install` / `yarn add` write the wrong lockfile and the wrong
  `node_modules` layout — turbo and CI read `pnpm-lock.yaml` semantically.
- `npx` fetches unpinned versions; use `pnpm exec` (repo binaries) or
  `pnpm dlx` (one-offs) instead.
- Adding a dependency: `pnpm --filter <pkg> add <dep>` — never to the root by
  accident.
- Installs happen in **your own worktree** only; `node_modules` is
  per-worktree.
