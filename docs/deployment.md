# Deployment — packaging, updates, remote backends, backup (Epic 8.4)

This is the operator-facing picture of §12 ("Platform and deployment") as it
actually landed. It complements the persistence notes in
`skill://plotroom-persistence` rather than repeating them — read those first for
the state-directory shape.

## Desktop installers

Tooling is the decision already recorded in `AGENTS.md`: **electron-builder
with electron-updater**. Config lives in `apps/desktop/electron-builder.yml`;
build it with:

```sh
pnpm --filter @plotroom/desktop package        # every configured target
pnpm --filter @plotroom/desktop package:linux  # linux only
```

Both run `scripts/stage-resources.mjs` first, which builds `@plotroom/server`
and `@plotroom/web`, deploys the server's **production** dependencies with
`pnpm --filter @plotroom/server deploy --prod` (so the packaged app never
depends on pnpm's symlinked workspace `node_modules` at runtime — see the
next section for why that is not simply "copy the folder"), and stages both
into `apps/desktop/build/resources/` for `electron-builder.yml`'s
`extraResources` to pick up.

**What is built vs configured, honestly:**

| Target                | Status                                                                              |
| --------------------- | ----------------------------------------------------------------------------------- |
| Linux (AppImage, deb) | **Built and verified** in this environment (see "What was verified" below)          |
| Windows (nsis)        | Configured only — no `wine` available in this environment to build or run it        |
| macOS (dmg)           | Configured only — packaging a `.app`/`.dmg` needs a macOS host; none available here |

### Two non-obvious fixes, recorded because they are easy to reintroduce

Both are commented in `electron-builder.yml` itself; restated here because a
future edit to that file is the likely place someone re-breaks them:

1. **electron-builder's file copier hard-codes excluding any top-level
   directory named exactly `node_modules`**, for _any_ `extraResources`
   matcher — no `filter:` override bypasses it
   (`app-builder-lib/util/filter.js`'s `createFilter`: "filter the root
   node_modules, but not a sub node_modules"). The fix is giving
   `node_modules` its **own** `extraResources` entry (`from:
.../node_modules`), which makes it that matcher's own root rather than a
   child — `createFilter`'s `src === file` short-circuit then applies before
   the name check ever runs.
2. **Do not dereference pnpm's virtual store when staging.** `pnpm deploy`
   produces real, mostly-symlinked `node_modules` pointing into
   `node_modules/.pnpm/...`; these are **relative** symlinks and
   electron-builder's copier preserves symlinks as symlinks, so leaving them
   alone is correct and was verified directly. Flattening them (tried,
   reverted) copies each direct dependency's own files but severs the
   "package's real on-disk location has its own private `node_modules`
   sibling inside `.pnpm/`" relationship pnpm's strict, non-hoisted
   resolution depends on — a transitive dependency two hops down
   (`@plotroom/db`'s own `better-sqlite3`) silently stopped resolving the one
   time this was tried.

Also: `electron` (the binary) is a **devDependency**, not a dependency —
electron-builder refuses to build otherwise ("Package electron is only
allowed in devDependencies").

### What was verified (this environment, Linux, headless via `xvfb-run`)

- `pnpm --filter @plotroom/desktop package:linux` produces a working
  `PlotRoom-<version>.AppImage` and `.deb`, both containing
  `resources/server/` (the deployed server, `node_modules` included) and
  `resources/web/dist/` (the built renderer), in the same _relative_ sibling
  layout `main.ts`'s `SERVER_ENTRY` and `apps/server`'s `defaultStaticDir()`
  already assume in dev — no packaged-vs-dev branch needed in either file.
- The packaged server actually boots (`ELECTRON_RUN_AS_NODE=1
<packaged-binary> resources/server/dist/index.js`) and answers
  `/api/health`, `/`, and `/api/maintenance/state` correctly.
- The packaged Electron app itself (not just the server) launches headlessly
  under `xvfb-run --no-sandbox`, single-instance-locks correctly, and (see
  "Remote backends" below) connects to a remote backend, injects the
  credential into both `/api/*` and the `/ws` upgrade, and never spawns a
  local server while doing so.

Not verified here: a real desktop environment (icon rendering, taskbar
integration, `.desktop` file association), because this environment has
neither a GUI session nor a package manager willing to install the `.deb`
outside a container.

## Updates

`apps/desktop/src/updater.ts` wires `electron-updater`'s `autoUpdater` behind
principle 2's rule, restated precisely because "check" and "install" are not
the same gesture:

- **Checking is a scheduled read**, safe on launch and on an interval
  (`PLOTROOM_UPDATE_CHECK_INTERVAL_HOURS`, default 24, `0` disables the
  schedule — same convention as `PLOTROOM_COMPACTION_INTERVAL_SECONDS` et
  al.) and from the "Check for Updates…" menu item. A check alone never
  downloads or changes anything.
- **Downloading needs consent**: `autoDownload` is `false` unless the
  operator's own persisted `autoInstallUpdates` setting (in
  `desktop-config.json`, see below) says otherwise; a found update instead
  raises a native "Download now?" dialog.
- **Installing always asks again**: after a download finishes, a second
  dialog ("Restart now to install?") gates `quitAndInstall()`.
  `autoInstallOnAppQuit` is never set `true` from this module regardless of
  the setting above — installing silently on quit is a second, stronger
  claim this batch does not make on the operator's behalf.

**Deferred, and recorded as deferred (not silently assumed):** `publish` is
unset in `electron-builder.yml`. The actual update-feed host (GitHub
Releases, a generic HTTP server, S3, …), the channel strategy, and
code-signing posture are none of them decided — packaging and signing
certificates were never in scope for this environment either. Without a
publish target, `checkForUpdatesNow` catches the resulting error and logs a
warning rather than crashing; the mechanism is real, the hosting decision is
not.

## Local-binding posture (verified from the packaged app)

Server-side enforcement already existed and is unchanged by this batch
(`apps/server/src/security/bind-policy.ts`'s `checkBindPolicy`,
`credential.ts`'s `checkCredential`) — this batch verified it end to end from
a **packaged** app's perspective rather than rebuilding it:

- The packaged server, run with no extra configuration, binds
  `127.0.0.1` and requires no credential — confirmed by hitting
  `/api/health` directly.
- A remembered **remote** backend's credential is carried on every request
  bound for that backend by the desktop shell itself
  (`credential-injection.ts`, wired in `main.ts`), never by the renderer —
  confirmed against two real server instances under a headless Electron
  window: every `/api/*` call and the `/ws` upgrade both carried
  `Authorization: Bearer <credential>`, and a wrong credential produced a
  named "could not connect" page rather than a page that loads and then
  fails every request silently.
  - **One real bug this surfaced and fixed:** the credential-injection
    predicate originally matched by full origin (scheme + host + port).
    `/api/*` requests and the `/ws` upgrade target the same backend but the
    browser gives them different schemes (`https:`/`wss:` or `http:`/`ws:`)
    for the identical connection, so the original predicate silently never
    matched `/ws` and every WS upgrade got refused with 401. Fixed to match
    on host:port only (`credential-injection.ts`'s `originMatches`).

## Remote backends — connect, remember, switch (§12, Epic 3.0 carry-over)

`apps/desktop`'s `spawnOrAttach` is local-only, as it always was. This batch
adds a second path, decided once at launch
(`main.ts`'s `connectToActiveBackend`):

- **Local** (default, `activeBackendId: null` in `desktop-config.json`):
  unchanged spawn-or-attach.
- **Remote**: health/credential-checks the remembered backend
  (`backend-connect.ts`) before ever loading its origin; on success, installs
  the credential injection above and loads that origin directly — the
  renderer served by a remote backend is the _exact same renderer_ served
  locally (never forked per target), so it has no idea it is talking to a
  remote origin, exactly as §12 describes ("workspaces, diffs, and file
  browsing refer to the _backend's_ machine").
- On failure, a named error page (not a crash, not a silently-broken page)
  points at the backend picker.

**The backend picker** (`apps/desktop/src/backend-picker*`) is a
desktop-owned `BrowserWindow` with its own preload — never a change to
`apps/web`/`packages/ui`, per this batch's file ownership. It lists
remembered backends, tests a candidate's health+credential before
remembering it ("test connection and remember" is one gesture, never a
credential saved blind), and switches the active backend. **Switching
relaunches the app** rather than tearing down and rebuilding the main
window's session/webRequest wiring in place — `main.ts`'s own startup
sequence already decides the right thing from `desktop-config.json` at
launch, so relaunch reuses that one decision path instead of maintaining a
second, live version of it. This is a scope decision, not a limitation
discovered too late to fix; it trades one window-reopen for not needing two
independently-correct versions of "which backend is this."

`desktop-config.json` lives beside Electron's own `userData`
(overridable via `PLOTROOM_DESKTOP_CONFIG_DIR`, e.g. for tests) — separate
from `PLOTROOM_STATE_DIR` (the _server's_ portable store), because which
backend to connect to is a fact that exists even when the active backend is
remote and no local server ever starts.

**A remembered backend's credential is stored in `desktop-config.json` as
plain text**, readable by anything with filesystem access to this
instance's `userData` directory. This is the same posture Electron's own
`safeStorage` (OS-keychain-backed encryption at rest) exists to improve on;
adopting it is deferred, not silently assumed adequate — recorded here
rather than in AGENTS.md's decisions list because it is a hardening
follow-up over an already-shipped mechanism, not an open product question.
The picker's own page never receives the credential back over IPC once
remembered (`PickerBackendSummary` carries only `id`/`label`/`url`); it is
read from disk once, by the main process, and injected directly into
outgoing requests.

## Tunnel workflow

Documented and verified as far as this sandboxed environment allows:

```sh
ssh -N -L <local-port>:127.0.0.1:<remote-port> <remote-host>
```

Forward **only** the page's loopback port — never expose the backend's bind
address itself. This is what makes local and tunnelled access identical
(§12): the browser/Electron window always talks to `127.0.0.1:<local-port>`,
exactly as it would talk to a local server, and the SSH tunnel is
byte-transparent underneath (it forwards the raw TCP stream — including the
`/ws` upgrade handshake — without distinguishing HTTP methods or protocols).

**What was verified here:** a self-tunnel on this same machine (`ssh -N -L
4801:127.0.0.1:4700 localhost`, a temporary key added to and removed from
`~/.ssh/authorized_keys` for the test) — `/api/health` and `/` through the
tunnel returned byte-identical results to hitting `127.0.0.1:4700` directly,
confirming the tunnel is transparent for this traffic. **Not verified here:**
an actual second machine (no cloud VM was available in this environment) or
the desktop app's own remote-backend connect _through_ a live tunnel process
(the remote-backend connect path itself was verified directly against two
local server instances — see "Local-binding posture" above — which exercises
the exact same credential-injection and health-check code a tunnelled
connection would use; only the SSH hop itself was not layered on top in the
same run). Recorded honestly as partially verified, not claimed as fully
end-to-end against a real remote host.

## Backup, move, and reset (portable store)

Server-side durability (Epic 2.3) is unchanged and already complete:
`GET /api/maintenance/state` states the portable unit (the state directory's
`plotroom.db` + `blobs/`) and what is deliberately excluded
(`workspaces/`, `git-cache/`, `runtime/` — all re-provisioned or rebuilt on
demand), and `POST /api/reset` / `GET /reset/plan` already implement
"a destructive verb states what it removes before it removes it."

This batch verified the same guarantee holds from a **packaged** app's
perspective: a packaged server (see "What was verified" above), started with
no configuration overrides, reports `stateDir` at its real default
(`~/.plotroom`, from `apps/server/src/config.ts`'s `defaultStateDir` — which
is `homedir()`-based and therefore identical whether the server is spawned
in dev, spawned by a packaged Electron app, or run standalone) and answers
`/api/maintenance/state` with the same accurate inventory shape as the dev
build.

**Reset/cleanup UX**: the server-side plan/confirm/execute verbs
(`apps/server/src/routes/maintenance.ts`) are complete and already tested
(Epic 2.3). This batch did not build an operator-facing surface for them —
that is a `packages/ui`/`apps/web` surface (a settings panel or similar),
outside this batch's file ownership. **Reported as a cross-track need**,
not silently deferred: someone (most naturally Track B's Epic 8.3, "Settings
and logs") needs to wire a UI over the existing `GET /reset/plan` /
`POST /api/reset` endpoints.

## Open decisions this batch deliberately did not make

Recorded here rather than assumed, per `AGENTS.md`'s rule that an
undecided question gets asked, not invented:

- **Update-feed hosting and channel strategy** (GitHub Releases vs a generic
  HTTP server vs S3; stable/beta channels). The mechanism (`electron-updater`,
  wired per principle 2) is ready for whichever is chosen; `publish` in
  `electron-builder.yml` is the one line that needs to change.
- **Code-signing posture** (macOS notarization, Windows Authenticode). Both
  need certificates/accounts this environment has none of; unsigned Linux
  builds do not need this at all (AppImage/deb do not require signing to
  run), so it was not blocking for what could be verified here.
