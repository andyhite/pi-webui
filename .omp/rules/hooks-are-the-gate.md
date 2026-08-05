---
description: Skipping git hooks (--no-verify, ALLOW_MAIN_COMMIT) is exceptional and must be justified
condition: '--no-verify\b|ALLOW_MAIN_COMMIT'
scope: tool
---

The hooks are the gate: branch-name check, repo-wide `format:check`,
commitlint. Skipping them is legitimate in exactly one shape — **the failure
is provably not yours** (e.g. another session's unformatted in-flight files
tripping the repo-wide format gate). Then, all three:

1. Prove your own slice passes: `pnpm exec prettier --check <your paths>`.
2. Validate the message yourself: `echo "$MSG" | pnpm exec commitlint`
   (`--no-verify` skips commit-msg too).
3. Say so in the commit body and in your report — a silent `--no-verify` reads
   as hiding a failure.

Never skip a hook to silence a failure your own change caused, and never set
`ALLOW_MAIN_COMMIT` — nothing you do happens on `main`.
