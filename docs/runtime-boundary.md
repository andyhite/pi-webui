# PlotRoom — Runtime Boundary

**Scope.** This doc owns the seam between PlotRoom and the agent runtime: the sidecar topology, what crosses it in each direction, what the sidecar disables and registers, the pinned tool policy, the capabilities an adapter declares, and runtime credential handling — the contract a change to `apps/session-host` or `apps/server/src/runtime` must not break. It defers phase derivation from the observations named here to [session-lifecycle.md](session-lifecycle.md), the injection ledger's product-facing semantics to [session-lifecycle.md](session-lifecycle.md) §6.5, approvals and claim enforcement mechanics to [enforcement.md](enforcement.md), and the PlotRoom-side gesture catalog that could ride this seam as tools to [interface-contract.md](interface-contract.md). It details spec §3.6 ("a run is what the product said it was"), §3.4 (claims and their non-path limits), §6.3–§6.5 (resume/fork, questions, injection), §6.6 (approvals), and principle 7 (derive from observation, never inference).

---

## 1. Topology

`apps/server/src/runtime/omp.ts`'s `createOmpRuntime` is the server-side adapter. It spawns `@plotroom/session-host` (`SESSION_HOST_ENTRY = "@plotroom/session-host/main"`) as a **detached sidecar**, one process per session:

- **Only the sidecar embeds the vendor SDK.** The entry is resolved with `createRequire(...).resolve(...)`, never imported, specifically so the vendor SDK and its native addon — "hundreds of megabytes of it" — never load into the server process. `apps/session-host/src/main.ts` says the same from the other side: "the vendor SDK is embedded here and nowhere else."
- **Observations are framed over fd 3.** The child is spawned with `stdio: ["pipe", "pipe", "pipe", "pipe"]` — four, not three (issue #109) — and `FRAME_FD = 3` is the private channel the sidecar's own writer uses. Sharing a channel with the vendor SDK's own stdout writes used to interleave and corrupt a frame, silently, in a system whose record _is_ the observation log; the fourth pipe is the fix, not a convenience.
- **stdout and stderr are drained, not shared.** Both must be _read_ or an unread pipe fills and blocks the sidecar mid-turn, which looks like a hang with no explanation. stdout is resumed and discarded — the vendor's own channel in a process holding the operator's provider tokens, and PlotRoom's posture is that nothing it writes may carry a credential, so nothing of stdout's is recorded either. stderr is logged at debug.
- **Detached means process-group, not orphaned.** The child gets its own process group (`detached: true`) so an abort can signal the group and take a runaway `bash` or browser child with it. It is not orphaned: stdin is a pipe from the server, and a server that dies closes it, ending the sidecar's own loop (POSIX; the group signal is unavailable on Windows, where the fallback reaches the sidecar alone).
- **Exit is bounded, graceful first.** `close(mode)` on the child handle: `"graceful"` sends `stop` and waits up to `GRACEFUL_EXIT_MS` (10s) for the sidecar to leave on its own — that is what flushes the runtime's own session file, so killing first costs the resume point. Past the bound, or on `"abort"`, it kills the whole process tree (`SIGKILL` to `-pid`, or the child alone as a fallback) and waits up to `KILL_EXIT_MS` (5s) more. A runtime that will not leave never hangs the server.

## 2. What crosses inbound

**Launch config** arrives two ways, never as a whole payload:

- As argv, built once by `buildSessionHostArgs` (`packages/core/src/sessions/adapters/omp/protocol.ts`) and parsed once by `apps/session-host/src/args.ts`: workspace path (`--cwd`), the SDK's own session directory (`--session-dir`), model pattern (`--model`), effort (`--effort`), an optional narrower tool list (`--tools`), and a resume/fork seed (`--resume`, plus `--through` for the turn a fork rewinds to). The parser refuses rather than defaults on any of these — a sidecar that invented a model or a workspace would run work nobody asked for.
- The **assembled prompt is deliberately not argv.** Assembled content (§3.5) routinely exceeds what an argv can carry, so it arrives as the first framed `prompt` command on stdin, exactly like every later turn.

**Framed commands**, after that, over the same stdin pipe (`SessionHostCommand` in `protocol.ts`, read by `apps/session-host/src/host.ts`): `prompt`, `inject`, `respond`, `stop`.

**ACK means accepted, not completed** — the load-bearing semantic of this channel. `host.ts`'s own comment states it: "every command is acknowledged when it has been taken into the runtime, never when it finished: a `prompt` that resolved on turn completion would make 'accepted' and 'done' the same word."

- `prompt` and `inject` write their `ack` immediately, while `deliver()` fires the actual `session.prompt(...)` call without the loop awaiting it — so a stop or a later injection can still be read while a turn is in flight. A `prompt` that fails after acceptance surfaces as a non-fatal `runtime-error` observation (the turn failed; the session is still alive); a failed `inject` surfaces as `injection-refused`, keyed by its injection id, and untracks it before that failure is reported, so a later `turn_start` cannot fabricate a delivery for text the runtime never queued.
- `respond` settles a request the permission gate or `plotroom_ask` raised through the shared `RequestBridge`. It `ack`s only if something was actually pending; otherwise it `nack`s — a silent success here would tell PlotRoom a blocked call had been released when nothing was blocked, or blocked twice.
- `stop` `ack`s and _then_ awaits `session.abort()` before the loop returns — acceptance of the stop is immediate, the session's actual end is not.

## 3. What crosses outbound

`apps/session-host/src/observations.ts` is, by its own header comment, "the only source file in the product where vendor event names appear" (issue #73). It **maps and never interprets**: it says what the runtime reported, never what the session is doing. Phase derivation from these observations — plus PlotRoom's own approval, claim, and silence state — is `@plotroom/core`'s job (decision 0001), documented in [session-lifecycle.md](session-lifecycle.md), not here.

The translation table, as read:

| Vendor event (`AgentSessionEvent`)  | `RuntimeObservation`                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| `turn_start`                        | `turn-started`, plus one `injection-delivered` per injection the turn-start queue diff resolves |
| `turn_end` (only if a turn is open) | `turn-ended`, carrying usage and, when reported, context-window occupancy                       |
| `message_update` / `text_delta`     | `output-delta`                                                                                  |
| `message_update` / `thinking_delta` | `reasoning-delta`                                                                               |
| `tool_execution_start`              | `tool-started`                                                                                  |
| `tool_execution_end`                | `tool-finished`                                                                                 |
| `auto_compaction_start`             | `compaction-started`                                                                            |
| `auto_compaction_end`               | `compaction-finished`                                                                           |
| `notice` (level `error`)            | `runtime-error`, non-fatal                                                                      |
| `notice` (any other level)          | dropped                                                                                         |
| everything else                     | dropped                                                                                         |

**Dropped by name**, per the file's own `default` case: model switches, todo reminders, retry bookkeeping, IRC, goals, and — called out explicitly — `agent_end`. `agent_end` is not mapped to `session-ended` on purpose: its `isTerminal: false` means an async delivery can resume the same session, and PlotRoom's own session ends when the _process_ ends, not when the vendor says a turn cycle finished.

**Injection delivery is proven, not assumed, at the next `turn_start`.** An accepted injection is tracked (`trackInjection`) by id and text; `getQueuedMessages().steering`, read at each `turn_start`, is diffed against the tracked set by text (the queue knows nothing of PlotRoom's injection ids) — text no longer present is delivered, text still present remains pending. A refused injection is untracked the moment the refusal is known, so it never enters that diff and can never be fabricated as delivered later.

**Fidelity direction — open, recorded here so a future change has somewhere to land:**

- **#159 / #163 (settings isolation)** — how much of the operator's ambient runtime configuration (beyond the pinned set in §4) is provably excluded from a session, versus merely not wired today.
- **#165 (ambient context files)** — whether a repository's own instruction files should reach a session through this seam or only through PlotRoom's own standing-instructions path (§3.8).
- **#169 (secret obfuscation)** — the credential posture in §7 stops secrets from being written by PlotRoom; obfuscating secrets a vendor error's forwarded message might itself carry is unresolved.
- **#170 (observed model)** — the spec's rule that "the concrete model that executed each turn is the recorded truth" (§3.5) has no observation in the table above that reports it per turn.
- **#171 (compaction pinning)** — `compaction-started`/`-finished` are observed, but nothing here ties a compaction event to run-history pinning (§4.4).
- **#172 (durable session refs)** — the `ready` frame's `ref` is the resume/fork address (§6.3); its durability across a sidecar or SDK upgrade is not proven by anything in this file.
- **#173 (completion contract)** — end reasons are enumerated in `RuntimeCapabilities`'s neighbor types, but the full completion contract (proven vs. claimed, §4.4/principle 3) is only partly reflected in `session-ended`.
- **#174 (elision visibility)** — the spec requires every runtime-side elision to be marked exactly like PlotRoom's own transcript releases (§6.1); nothing in the table above currently distinguishes an elided turn from a normal one.
- **#175 (cost fidelity)** — `reportsCost` (§6) is a capability flag; how a runtime that reports `false` prices itself against PlotRoom's own table, faithfully, is open.
- **#176 (config dump as record)** — whether the full resolved launch config (not just the argv slice in §2) should be captured verbatim as part of the session record.

## 4. What the sidecar disables, and what it registers

`apps/session-host/src/main.ts`'s `createAgentSession(...)` call turns off, explicitly, everything the SDK would otherwise discover or infer:

- `disableExtensionDiscovery: true`
- `enableMCP: false`
- `enableLsp: false`
- `enableIrc: false`
- `skills: []`, `rules: []`, `promptTemplates: []`, `slashCommands: []` — the operator's ambient configuration, which a session picking it up would run under instructions PlotRoom never assembled and cannot show (§3.5, §7.4)
- `hasUI: false` — no interactive surface; a question reaches the human through PlotRoom (§6.4), never the runtime's own prompt
- `autoApprove: false` — an auto-approved call would make the permission gate advisory

One flag is deliberately **not** set to restrict anything: `restrictToolNames: false`. Setting it `true` silently unloads inline extensions — no error, no warning, `loadedExtensions: 0` — which on the gated path means every tool call would run ungated (proven in issue #66). The restriction PlotRoom actually wants is the explicit tool set (§5) plus the four discovery switches above, not this flag.

The sidecar makes exactly **two registrations**, both bridged to the operator through the same `RequestBridge` over the frame channel rather than answered in-process:

1. **The permission gate** — `pi.on("tool_call", gateHandler)` (`apps/session-host/src/permission-gate.ts`), decision 0001's C6 for the embedded SDK: it runs before every tool call, read-tier included, and a `{block: true, reason}` result stops the call with no side effect.
2. **`plotroom_ask`** (`apps/session-host/src/ask-tool.ts`) — §6.4's structured questions, registered as a real typechecked tool rather than generated source, carrying no timeout on purpose (a default that answers on expiry is exactly what principle 2 forbids).

Both are verified live at boot, before anything reaches the model: extension load errors are fatal; `plotroom_ask` must appear by its exact tool name; the gate handler must be the _exact function reference_ the SDK's loader stored (not just "some `tool_call` handler"); and a reserved boot-assertion tool call must come back denied. A claim a config change could falsify silently is worse than no claim at all.

## 5. The pinned tool policy

`apps/session-host/src/tools.ts` pins the tool set explicitly rather than inheriting SDK discovery. As read, `PINNED_TOOL_NAMES` is exactly:

```
read, write, edit, ast_grep, ast_edit, glob, grep, bash, eval, web_search, inspect_image
```

Every exclusion the file documents, and its stated reason:

| Excluded                | Reason, as written                                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task`                  | Nothing that spends money outside PlotRoom's accounting fold — a subagent's cost is invisible to the parent's stats (proven in #66), so every §8 cap and every `spend_attributions` row would understate what a session cost. PlotRoom's fleet _is_ the delegation model, so a second one beside it is the drift principle 8 exists to prevent. |
| `security_scan`         | Out for the same money-outside-accounting reason — it runs its own model calls.                                                                                                                                                                                                                                                                 |
| `todo`                  | Duplicates the attention queue (§7.1).                                                                                                                                                                                                                                                                                                          |
| memory and skill tools  | Duplicate standing instructions (§7.4) and the context graph (§3).                                                                                                                                                                                                                                                                              |
| `checkpoint` / `rewind` | Duplicate versions and forks (§6.3).                                                                                                                                                                                                                                                                                                            |
| `hub`                   | Duplicates steering and broadcast (§6.5).                                                                                                                                                                                                                                                                                                       |
| `ask`                   | §6.4's structured questions arrive through the gate seam as PlotRoom's own tool (`plotroom_ask`, issue #81) — the runtime's own prompt is not a channel PlotRoom can answer.                                                                                                                                                                    |
| `computer`              | Desktop control has no extent a path claim can bound (§3.4); a claim ledger that cannot describe what a tool touches is one that does not gate it.                                                                                                                                                                                              |
| `lsp`                   | The session host runs with `enableLsp: false` (§4), and a tool named but unable to work is worse than an absent one.                                                                                                                                                                                                                            |

("One place states a rule" for the duplication group — `todo`, memory/skill, `checkpoint`/`rewind`, `hub` — is the file's own summary, not four independent decisions.)

**The recorded limits of exclusion-as-isolation** (spec §3.4): the tool allowlist keeps a session off surfaces PlotRoom already owns, but exclusion is not the same guarantee as a path claim. Claims cover the filesystem; a session's work can also hold a resource that is not a path — a supervised process, a bound port, a live evaluation kernel — and no claim bounds those. Today's recorded position: anything whose reach crosses the workspace boundary is refused outright, a session-scoped resource is admitted unclaimed but _observed_, and whether the claim vocabulary itself should extend to a named non-path extent is open (**#177 / #178**) — the pinned tool list narrows exposure, it does not close this gap.

**Direction, recorded rather than built:** the pinned set above is generic coding capability, not PlotRoom's own gesture catalog. Principle 8 says the vocabulary is declared once, so the same gestures a human has in the UI are available to an agent as a tool. Delivering PlotRoom's own gestures (claims, budgets, approvals, standing instructions, and the rest of §3–§9) as custom tools at this seam — rather than only through the permission gate and `plotroom_ask` — is open (**#160 / #161**).

## 6. Capabilities declaration

`RuntimeCapabilities` (`packages/core/src/sessions/runtime.ts`) is what an adapter declares about the runtime behind it; PlotRoom emulates or refuses whatever it does not have:

- `fork: "any-point" | "turn-boundary" | "none"` — `"none"` means PlotRoom emulates a fork by seeding a new native session from its own transcript record (§6.3).
- `injection: "between-turns" | "next-turn"` — governs how long an injection can stay "queued" before delivery (§6.5).
- `reportsCost: boolean` — if false, PlotRoom prices token usage from its own model-pricing table instead of trusting the runtime's number.
- `reportsContextWindow: boolean` — if false, the context meter is estimated from cumulative usage against the model's known window.
- `enforcesPermissions: boolean` — whether the runtime lets the host decide tool permissions per call, so approvals (§6.6) and claims (§3.4) gate the runtime rather than advise it (decision 0001, C6). `checkPermissionEnforcement` is the predicate that refuses when this is false: a runtime that cannot be trusted to refuse a call on the host's word may not run work that depends on either guarantee.

**The vendor-dialect rule: PlotRoom never speaks a vendor's vocabulary at its own seam.** Two examples of the same rule, at both ends of this document: `SESSION_EFFORTS` is PlotRoom's own effort vocabulary, mapped onto the vendor's `thinkingLevel` inside the sidecar (`parseThinkingLevel`), never the reverse; and `RuntimeObservation`'s kinds are PlotRoom's own vocabulary, with `observations.ts` as the single, typechecked place a vendor event name is ever read (§3). A vendor release that renames an event costs one mapping change there — never a change to a session record, and never a vendor word appearing anywhere else in the product.

## 7. Runtime auth

The sidecar resolves model credentials itself, from the operator's own credential store (`discoverAuthStorage()`, called inside the session-host process) — **never injected by the server.** `apps/server/src/runtime/omp.ts` spawns the child with `env: process.env`, unmodified; the server holds no provider tokens at any point. This is the same stance PlotRoom already takes for workspace git (§3.4: "app-held credentials are never used for workspace git operations"), carried across to the runtime seam rather than invented for it.

What that costs the sidecar, stated in `main.ts`: nothing PlotRoom writes over this seam may carry a credential — not a frame, not a log line, not an error — which is why a startup failure is reported as its own sentence rather than by forwarding a stack trace, and a session with no authenticated model says exactly that. One accepted exception: a vendor error's `message` is forwarded verbatim into a `fatal` frame and into a failed turn's observation, because narrowing it to a class and a code would cost the operator the only account of what went wrong — forwarded knowingly, not by omission.
