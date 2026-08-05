---
description: Generated files are never hand-edited — run the generator instead
condition:
  - "**/theme.generated.css"
  - "**/pnpm-lock.yaml"
interruptMode: tool-only
---

You are about to write a **generated file** by hand. Don't:

- `packages/toolkit/src/theme.generated.css` is emitted by `renderThemeCss`
  from the token table — edit the tokens and rebuild; a hand edit is
  overwritten by the next build and lies until then.
- `pnpm-lock.yaml` changes only through pnpm commands (`pnpm add`,
  `pnpm install`, `pnpm up`). A hand-edited lockfile breaks turbo's semantic
  lockfile reading and CI's affected-package selection.

If a task seems to require editing one of these directly, the task is
actually about the file's _source_ — find it.
