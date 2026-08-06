---
description: This is a Bun workspace — npm, pnpm, yarn, and npx corrupt the lockfile and bypass the pinned toolchain
condition: '\b(npm|pnpm|yarn)\s+(install|i\b|ci\b|add|remove|run|exec|dlx|test)\b|\bnpx\s'
scope: "tool:bash"
interruptMode: tool-only
---

This repository is a **Bun workspace** — `packageManager` pins
`bun@1.3.14` and the lockfile is `bun.lock`:

- `npm install` / `pnpm add` / `yarn add` write the wrong lockfile and the
  wrong `node_modules` layout. Turbo reads `bun.lock` semantically to scope
  `--affected`, and CI installs with `bun install --frozen-lockfile`.
- `npx` fetches unpinned versions; use `bunx` for repo binaries and one-offs.
- Adding a dependency: `bun add --filter <pkg> <dep>` — never to the root by
  accident.
- Running a script: `bun <script>` at the root; one package only with
  `bun run --filter=<pkg> <script>`.
- Installs happen in **your own worktree** only; `node_modules` is
  per-worktree.

The pnpm-era commands in older `docs/` prose are stale, not authority — the
scripts in `package.json` and `.github/workflows/` are.
