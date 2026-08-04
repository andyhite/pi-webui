# 0005 — Bun in the stack, and how the session host ships

- **Status:** Accepted, with one part deferred
- **Date:** 2026-08-04
- **Issues:** #78 (decision), #92 (packaging)
- **Deciders:** operator

## Context

Embedding omp (see 0001's amendment) requires Bun. `@oh-my-pi/pi-coding-agent` is
now a dependency of `apps/session-host`, pinned exactly at 17.2.8: it ships its
entry as raw TypeScript (`main: ./src/index.ts`), declares
`engines.bun >= 1.3.14`, touches Bun APIs in 177 of its 1,165 source files, and
carries a per-platform native addon that is 296 MB on disk for linux-x64. Importing
it under Node fails outright. So the question was never whether Bun enters the
stack, but how far it spreads — and, separately, whether the desktop shell should
become Bun-based too (Electrobun).

## Decision

**(a) Bun enters the stack for `apps/session-host` only.** It is a toolchain
addition, not a replacement: pnpm remains the package manager, Turborepo the task
runner, and Node 22 runs everything else.

**(b) The server stays on Node**, deferred rather than refused. The coupling is
edge-shaped — essentially three files hold it: the `better-sqlite3` driver in
`packages/db`'s client, `@hono/node-server` plus `@hono/node-ws`'s
`injectWebSocket` in the server entry, and the plugin host's
`new Worker(…, { execArgv: [] })`. The test surface is cheap (no `vi.mock`, no
snapshots, no jsdom anywhere), so the migration is small but buys no product
behavior, and it is not worth spending while the runtime swap is the critical path.
**The trigger is the shell decision:** if the desktop shell becomes Bun-based, Node
exists nowhere else and the migration pays for itself. Recorded for whoever does
it: `bun:sqlite` deletes the two-entry `extraResources` split that exists only
because a native module has to be staged.

**(c) Electrobun is deferred, and priced as one change that includes (b).** The
Electron surface is thin — twelve APIs, no `safeStorage`, `Tray`, `protocol`
or `globalShortcut` — but one mechanism has no analogue: the desktop spawns the
server with `process.execPath` and `ELECTRON_RUN_AS_NODE`, the Electron binary
acting as Node, because a packaged app bundles no separate runtime. Under a
Bun-based shell a packaged app must either ship a runtime for the server or run the
server on the shell's runtime, so the shell swap forces the server migration.
Whether Playwright can drive an Electrobun window is unanswered and is the gate on
revisiting this. Until then the shell is Electron and the renderer is Chromium.

**(d) The session host ships as a per-platform compiled binary.** Packaged builds
compile `apps/session-host` with `bun build --compile`: one self-contained
artifact, no runtime prerequisite for an installed app, and no `node_modules` to
stage — which also removes the native-module staging split. Development uses
host-installed Bun; that difference is deliberate and documented rather than
discovered. **Gate:** the SDK's platform native addon must be proven to survive
compilation before a release depends on it; if it does not, the fallback is
bundling a Bun binary plus `node_modules`, recorded rather than worked around.
Cross-compilation is unavailable either way, so releases need native CI runners per
platform.

## Consequences

CI gains Bun for three things — typechecking the session host, running its tests,
and producing its compiled binary — while every other package stays on Node.
Anything that assumed the operator installs the agent runtime themselves changes:
PlotRoom now owns that process, which is why verifying a tunnelled backend has to
exercise a spawned session host on the remote host, and why the installer stages a
binary rather than a dependency tree.
