# 0001 — Session runtime abstraction

- **Status:** Accepted at Sync 1, with one operator amendment: **adapter
  order flipped — pi coding agent first, Claude Agent SDK second.** The
  multi-provider reach (pi drives Claude models and hundreds of others) and
  its native injection/fork semantics outweigh the Claude SDK's blessed
  per-call permission callback, which pi must match via tool-layer wrapping —
  verified during adapter v1, before claims enforcement depends on it.
- **Date:** 2026-02-10
- **Epic:** 4.1 — Session runtime abstraction (`sessions`)
- **Deciders:** Track C (proposal), operator (acceptance)

## Context

PlotRoom sessions (spec §3.6) are driven by an external agent runtime, and the
biggest open decision in AGENTS.md is which runtime(s) and where the
abstraction boundary sits. The spec constrains the boundary tightly:

- **Phases are derived, never agent-reported** (§3.6, principle 7): thinking,
  responding, running a named tool, compacting, waiting for approval, waiting
  for input, waiting on a claim, stopped, failed, idle — computed continuously
  by PlotRoom from what it observes.
- **Injection is queued → delivered** (§6.5): a runtime may only accept input
  between turns, so an injection shows as queued until the runtime actually
  consumes it. Delivery acknowledgment is part of the contract, not a nicety.
- **Sessions are records the product owns** (§3.6): readable, resumable,
  forkable, deletable, always — including **fork from any point** (§6.3),
  which inherits the conversation up to that point.
- **Accounting per session** (§3.6): turns, elapsed, tokens, cost, time since
  last activity, and a context-window meter with thresholds.
- **Out-of-budget is its own outcome** (§3.6, §8): distinct from failure; a
  retry must not blindly re-run it.

So the abstraction PlotRoom owns is: **start, stream (observations, from which
phases are derived), inject-between-turns, stop, fork-from-point, and
accounting taps.** A runtime adapter supplies raw capability under that
interface and nothing above it.

## Criteria

| #   | Criterion               | What it means concretely                                                                                                                                |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Observable stream       | Fine-grained events (reasoning vs output deltas, named tool start/finish, compaction) sufficient to _derive_ phases without trusting agent self-reports |
| C2  | Injection semantics     | Input can be submitted while a turn is in flight and is consumed at the next boundary, with a detectable delivery point (§6.5 queued → delivered)       |
| C3  | Resume and fork         | Sessions addressable and resumable; fork from an arbitrary transcript point, or enough transcript access for PlotRoom to emulate it                     |
| C4  | Accounting taps         | Per-turn token/cost usage and context-window occupancy exposed as data, not scraped from text                                                           |
| C5  | Stop                    | Graceful interrupt and hard abort, distinguishable                                                                                                      |
| C6  | Permission interception | Tool permissions decided by the host per call, so PlotRoom's approvals (§6.6) and claims (§3.4) gate the runtime rather than advise it                  |
| C7  | Local-first, embeddable | Runs against a local server, no cloud control plane required (§12); embeddable from a Node/TypeScript server process                                    |
| C8  | Model/effort choice     | Per-session model and effort at launch (§3.6)                                                                                                           |
| C9  | Stability of surface    | Documented programmatic surface, versioned, plausible to keep an adapter working for months                                                             |

## Candidates

Versions checked against the npm registry on 2026-02-10.

### A. Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, 0.3.x)

Anthropic's programmatic surface over the Claude Code runtime (renamed from
the Claude Code SDK). TypeScript-native; a `query()` call returns an async
iterable of typed messages, with a streaming-input mode for multi-turn
sessions.

- **C1:** strong — distinct message/stream event types for thinking vs text vs
  tool use, tool names and inputs/outputs, compaction boundary events.
- **C2:** strong — streaming-input mode accepts messages while a turn runs;
  the runtime consumes them at turn boundaries; `interrupt()` exists for
  preemption. Delivery is observable as the message's echo/turn start.
- **C3:** good — sessions have ids, `resume` reattaches, and a fork-session
  option branches instead of continuing. Fork from an _arbitrary point_ is not
  first-class; PlotRoom emulates it from its own transcript record (see
  "Owned vs supplied").
- **C4:** strong — result messages carry token usage and cost USD; context
  compaction events and usage let a window meter be derived.
- **C5:** good — interrupt (graceful) vs killing the underlying process
  (abort).
- **C6:** strong — a `canUseTool` callback puts the host in the tool-approval
  path per call; hooks fire on tool and lifecycle events.
- **C7:** good — local; the SDK drives a bundled CLI/runtime as a child
  process. Requires Anthropic auth.
- **C8:** yes — model selection, thinking budget.
- **C9:** moderate — actively developed, fast-moving (0.x), one vendor.

### B. OpenAI Codex SDK (`@openai/codex-sdk`, 0.1x) / Codex CLI

TypeScript SDK over the Rust Codex CLI. Thread-based: `startThread()` /
`resumeThread(id)`, `run(prompt)` returning streamed JSONL-backed events; also
usable headlessly via `codex exec --json`.

- **C1:** adequate — item/event stream includes agent messages, reasoning,
  command executions, file changes, token counts; granularity is coarser than
  A but sufficient for phase derivation.
- **C2:** weak — the turn model is run-to-completion per `run()` call; there
  is no first-class mid-turn input queue. Injection degrades to "queued by
  PlotRoom, delivered as the next `run()`" — legal under §6.5 but delivery
  waits for the whole turn.
- **C3:** partial — resume by thread id; no fork-from-point. Emulation
  possible only by replaying PlotRoom's transcript into a fresh thread.
- **C4:** good — token count events; cost derivable from model pricing.
- **C5:** adequate — abort the in-flight run/process.
- **C6:** partial — approval policy modes and sandbox levels are configured
  per thread; per-call host interception is not the primary model.
- **C7:** good — local CLI; requires OpenAI auth.
- **C8:** yes.
- **C9:** moderate — very active, 0.x, one vendor.

### C. pi coding agent (`@mariozechner/pi-coding-agent`, 0.7x)

Open-source coding agent with explicit session management, an RPC/headless
mode, and a provider-agnostic model layer (`pi-ai`). Sessions are local JSONL
records with tree structure (branching is a native concept).

- **C1:** strong — RPC mode emits granular events (turn/message/tool
  lifecycle, deltas) designed for embedding.
- **C2:** strong — steering messages are an explicit feature: input submitted
  mid-turn is queued and consumed between tool calls / at turn boundaries,
  which is exactly the §6.5 queued → delivered shape.
- **C3:** strong — session files are local, inspectable JSONL with branching;
  forking from a point is close to native.
- **C4:** good — per-turn usage in session records; multi-provider cost
  tables via its model layer.
- **C5:** good — abort/interrupt in RPC mode.
- **C6:** partial — extensible tool layer allows wrapping, but there is no
  single blessed per-call permission callback like A's.
- **C7:** strong — fully local, model-agnostic (Anthropic, OpenAI, others).
- **C8:** yes, across providers.
- **C9:** weaker — small project, effectively one maintainer, fast-moving.

### D. OpenCode (`@opencode-ai/sdk`, 1.x)

Open-source agent with a client/server architecture: `opencode serve` exposes
an HTTP+SSE API; the TUI is just one client. Multi-provider via models.dev.

- **C1:** adequate — server emits session/message/part events over SSE;
  granularity sufficient for coarse phase derivation.
- **C2:** adequate — messages posted to a busy session queue server-side.
  Delivery detection requires correlating the queued prompt with its turn.
- **C3:** partial — sessions persist server-side with revert/share; fork from
  arbitrary point not first-class.
- **C4:** adequate — usage on messages.
- **C5:** good — abort endpoint.
- **C6:** partial — permission system exists (ask/allow rules) with an
  approval API, less host-programmable than A.
- **C7:** strong — local server; multi-provider.
- **C8:** yes.
- **C9:** moderate — popular, 1.x, but the SDK surface churns.

### E. Agent Client Protocol (ACP, `@zed-industries/agent-client-protocol`, 0.4.x)

Not a runtime — a JSON-RPC-over-stdio protocol (from Zed) that standardizes
editor ↔ agent communication: `session/new`, `session/prompt`, streamed
update notifications (message chunks, tool calls, plans), permission requests,
cancel. Adapters exist for several agents (Gemini CLI natively; Claude Code
via bridge).

- **C1:** adequate — standardized update kinds cover message/thought/tool
  activity; compaction and fine token accounting are not standardized (left to
  `_meta` extensions).
- **C2:** weak-to-adequate — prompt turns are request/response; mid-turn
  queueing is client-side.
- **C3:** weak — `session/load` is optional; fork is not in the protocol.
- **C4:** weak — no standardized usage/cost surface yet.
- **C5:** good — `session/cancel`.
- **C6:** strong — permission requests are first-class protocol messages.
- **C7:** strong — local stdio processes.
- **C9:** moderate — young protocol, but multi-vendor by design.

## Decision (recommendation)

1. **PlotRoom owns a `SessionRuntimeAdapter` interface** (below). Everything
   the spec makes product behavior — phase derivation, queued→delivered
   injection bookkeeping, accounting aggregation, budgets, session records,
   fork bookkeeping — lives in `@plotroom/core` (`core/src/sessions/`) and is
   runtime-independent. Adapters translate one runtime's native surface into
   `RuntimeObservation` events and a small command set. Adapters are processes
   owned by the server, never by the renderer.
2. **First concrete adapter: pi coding agent** (operator decision at Sync 1).
   Strongest on injection semantics (steering messages are natively
   queued → delivered, exactly §6.5), closest to native on fork-from-point
   (local JSONL sessions with branching), fully local, and multi-provider —
   one adapter reaches Claude models and hundreds of others, which is also
   the hedge against single-vendor auth or pricing changes. Its known gap is
   C6: no single blessed per-call permission callback, so PlotRoom's
   approvals (§6.6) and path claims (§3.4) gate tools via pi's extensible
   tool layer — this wrapping is verified early in adapter v1, before claims
   enforcement depends on it.
3. **Second adapter target: Claude Agent SDK** — strongest on observation
   granularity, cost-as-data, and per-call permission interception
   (`canUseTool`); it proves the abstraction is real (two adapters, one
   product behavior). OpenAI Codex SDK is the alternative second adapter if
   provider coverage matters more than injection fidelity.
4. **ACP is a watch item, not the boundary.** Today it standardizes too little
   of what PlotRoom needs (no usage/cost, no fork, thin compaction story). The
   adapter interface below is deliberately close in shape to ACP's session
   model so an `AcpAdapter` can be one adapter among several if the protocol
   matures — but PlotRoom's boundary is its own interface, not ACP.

### Why not the alternatives as the boundary

- Adopting ACP as the boundary would outsource exactly the parts the spec
  forbids outsourcing (phases, accounting) to a protocol that doesn't carry
  them yet.
- Building only against the Claude Agent SDK without an adapter seam would
  couple session records — permanent product data — to one vendor's 0.x
  surface, and the development plan requires the runtime decision to be an
  abstraction, not a dependency choice.

## Proposed adapter interface

Draft, for review — **not shipped code**. Lands in `packages/core/src/sessions/`
in W4–5 per the plan, coordinated with Track A on shared types. Naming
follows the spec's language (observations, phases, injection).

```ts
/** What a runtime adapter declares it can do; PlotRoom emulates or refuses the rest. */
export interface RuntimeCapabilities {
  /** Native fork support. "none" means PlotRoom emulates by seeding a new
   * native session from its own transcript record (§6.3). */
  readonly fork: "any-point" | "turn-boundary" | "none";
  /** Whether input submitted mid-turn is consumed at the next boundary
   * without a new explicit turn ("between-turns"), or only as the next
   * turn's prompt ("next-turn"). Governs how long "queued" lasts (§6.5). */
  readonly injection: "between-turns" | "next-turn";
  /** Whether the runtime reports monetary cost itself; if false PlotRoom
   * prices token usage from its own model-pricing table. */
  readonly reportsCost: boolean;
  /** Whether context-window occupancy is reported; if false the meter is
   * estimated from cumulative usage against the model's known window. */
  readonly reportsContextWindow: boolean;
}

export interface SessionRuntimeAdapter {
  readonly id: string; // e.g. "claude-agent-sdk"
  readonly capabilities: RuntimeCapabilities;

  /** Start a new native session. The assembled content (§3.5) and per-session
   * choices (§3.6: model, effort, tool permissions) are inputs; the adapter
   * never assembles or widens anything. */
  start(config: RuntimeStartConfig): Promise<RuntimeSessionHandle>;

  /** Reattach to a native session PlotRoom previously recorded. */
  resume(
    ref: RuntimeSessionRef,
    config: RuntimeResumeConfig,
  ): Promise<RuntimeSessionHandle>;

  /** Fork natively where capabilities.fork allows; otherwise PlotRoom calls
   * start() with a transcript-prefix seed instead. */
  fork(
    ref: RuntimeSessionRef,
    point: TranscriptPoint,
    config: RuntimeStartConfig,
  ): Promise<RuntimeSessionHandle>;
}

export interface RuntimeSessionHandle {
  /** Opaque native identity, persisted in the session record so resume/fork
   * survive a server restart. */
  readonly ref: RuntimeSessionRef;

  /** The single stream PlotRoom derives everything from. Ends when the
   * native session ends; throwing here is a runtime failure, which PlotRoom
   * maps to the `failed` phase — a crashed adapter never crashes the host. */
  observations(): AsyncIterable<RuntimeObservation>;

  /** Submit content mid-flight. Resolves as soon as the runtime has accepted
   * the input into its queue — NOT when consumed. Consumption is observed as
   * an `injection-delivered` observation carrying this receipt's id (§6.5). */
  inject(input: InjectedInput): Promise<InjectionReceipt>;

  /** Answer a runtime-raised request (tool permission → PlotRoom approval
   * §6.6; structured question → §6.4). */
  respond(requestId: RuntimeRequestId, outcome: RequestOutcome): Promise<void>;

  /** "graceful" asks the runtime to wind down; "abort" terminates. Both end
   * the observation stream with a `session-ended` observation whose reason
   * distinguishes stop from failure from out-of-budget (§3.6). */
  stop(mode: "graceful" | "abort"): Promise<void>;
}

/** Everything is timestamped by the adapter at observation time; PlotRoom
 * computes elapsed and time-since-last-activity itself (§3.6). */
export type RuntimeObservation = { at: EpochMillis } & (
  | { kind: "turn-started"; turn: number }
  | { kind: "reasoning-delta"; text: string } // → phase: thinking
  | { kind: "output-delta"; text: string } // → phase: responding
  | { kind: "tool-started"; toolName: string; callId: string; input: unknown }
  | { kind: "tool-finished"; callId: string; output: unknown; isError: boolean }
  | { kind: "compaction-started" } // → phase: compacting
  | { kind: "compaction-finished" }
  | {
      kind: "request-raised";
      requestId: RuntimeRequestId;
      request: RuntimeRequest;
    }
  | { kind: "injection-delivered"; injectionId: InjectionId }
  | { kind: "turn-ended"; turn: number; usage: TurnUsage }
  | { kind: "session-ended"; reason: SessionEndReason }
  | { kind: "runtime-error"; message: string; fatal: boolean }
);

export interface TurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  /** Present only when capabilities.reportsCost. */
  readonly costUsd?: number;
  /** Present only when capabilities.reportsContextWindow. */
  readonly contextWindow?: { usedTokens: number; maxTokens: number };
}

export type SessionEndReason =
  | { kind: "completed" } // producing session proved completion (checked by PlotRoom, not here)
  | { kind: "stopped"; by: "user" | "budget" } // budget stop is PlotRoom-initiated; distinct outcome, §3.6
  | { kind: "failed"; message: string };
```

**Phase derivation is a pure reducer in `@plotroom/core`, not adapter code** —
the same pattern as the graph predicates (`checkConnection`, `wouldCycle`):

```ts
/** Derived, never agent-reported (§3.6, principle 7). waiting-approval and
 * waiting-on-claim come from PlotRoom's own approval/claim state joined in;
 * idle vs waiting-input from whether a turn is open; a silence timeout over
 * last-activity guards against a runtime that stops observing. */
export function deriveSessionPhase(
  state: SessionObservationState,
): SessionPhase;

export type SessionPhase =
  | { kind: "thinking" }
  | { kind: "responding" }
  | { kind: "tool-running"; toolName: string }
  | { kind: "compacting" }
  | { kind: "waiting-approval" }
  | { kind: "waiting-input" }
  | { kind: "waiting-on-claim" }
  | { kind: "stopped" }
  | { kind: "failed" }
  | { kind: "idle" };
```

## What PlotRoom owns vs what an adapter supplies

| PlotRoom owns (runtime-independent)                                                                                       | Adapter supplies (per runtime)                                         |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Phase derivation (reducer over observations + own approval/claim state + silence timeouts)                                | Raw observation stream with timestamps                                 |
| Injection ledger: queued → delivered state, the graph edge, attribution (§6.5, principle 1)                               | Accepting input mid-flight; emitting `injection-delivered`             |
| Session record: transcript, resumability, fork bookkeeping, deletion (§3.6); fork emulation via transcript-prefix seeding | Native session identity (`ref`); native resume; native fork if capable |
| Accounting aggregation: turns, elapsed, last-activity, cost totals, pricing when runtime reports none, window estimation  | Per-turn `TurnUsage` as observed                                       |
| Budgets and the out-of-budget outcome (PlotRoom stops the session; the reason is recorded as budget, not failure)         | Graceful stop / abort                                                  |
| Approvals, structured questions, claims — decided by product state (§6.4, §6.6, §3.4)                                     | Raising requests; honoring `respond()`                                 |
| Context assembly, run preview, run history (§3.5, §4)                                                                     | Consuming assembled content as given                                   |

## Risks

- **0.x SDK churn (all candidates).** Mitigated by the seam: adapter code is
  the only code that touches a vendor surface, and session records store
  PlotRoom's observation log, not vendor payloads.
- **Fork emulation fidelity.** A fork seeded from a transcript prefix is not
  bit-identical to a native fork (provider-side caches, tool state). §6.3's
  outside-world markers bound the damage; the capability flag keeps the
  difference honest in the UI.
- **Phase derivation blind spots.** A runtime that goes silent during a long
  tool call is indistinguishable from a hung one; the derivation needs a
  last-activity timeout to surface "possibly stalled" as a health signal
  rather than a wrong phase. (Also listed as a fleet health concern, §7.)
- **Cost truth.** Where the runtime reports cost (Claude Agent SDK) and
  PlotRoom also prices tokens, the two can disagree; the recorded number must
  name its source.
- **Delivery detection on next-turn-only runtimes** (Codex-style): "queued"
  can last an entire long turn. That is spec-legal (§6.5 exists precisely for
  this) but needs the UI to show it honestly.
- **Auth/entitlement coupling.** Vendor SDKs require their vendor's
  credentials; pi-first keeps the primary path multi-provider, and the second
  adapter keeps the seam honest.
- **C6 wrapping on pi.** pi lacks a single blessed per-call permission
  callback; approvals/claims gating is built on its tool layer and must be
  verified early in adapter v1 — if it cannot be enforced (not advised),
  adapter order reverts to the Claude Agent SDK.

## Proposed AGENTS.md update

> For the operator to accept; do not apply until accepted. Replaces the
> "Agent runtime(s) driving sessions, and the session/runtime abstraction
> boundary" bullet under AGENTS.md's decision archive and adds a paragraph to the
> persistence/architecture notes.

Remove from AGENTS.md's decision archive:

```
- Agent runtime(s) driving sessions, and the session/runtime abstraction boundary
```

Add under a new heading (e.g. after "Canvas notes"):

```markdown
### Session runtime notes

The runtime boundary is decided (docs/decisions/0001-session-runtime-abstraction.md).
PlotRoom owns a `SessionRuntimeAdapter` interface in `@plotroom/core`
(`core/src/sessions/`); adapters translate one runtime's surface into a
timestamped `RuntimeObservation` stream plus start / resume / fork / inject /
respond / stop. The first adapter is the **pi coding agent** (multi-provider,
native queued→delivered injection, near-native fork); the second (proving the
seam) is the **Claude Agent SDK**. ACP is tracked but is not the boundary.

Non-negotiables at this seam:

- **Phases are derived in core** from observations (plus PlotRoom's own
  approval/claim state and silence timeouts) — never agent-reported.
- **Injection is a ledger**: `inject()` resolves on queue acceptance;
  delivery is a separate observed event. The UI shows queued vs delivered.
- **Session records store PlotRoom's observation log**, not vendor payloads,
  so resume/fork/accounting survive vendor churn; fork-from-point is emulated
  by transcript-prefix seeding when a runtime lacks native fork.
- **Out-of-budget stops are initiated by PlotRoom** and recorded as their own
  outcome, distinct from failure.
```
