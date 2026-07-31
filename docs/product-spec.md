# PlotRoom — Product Specification

**Status:** North Star v1 · **Date:** 2026-07-31
**Purpose:** the definitive statement of what PlotRoom is and how it behaves — the entrypoint to a ground-up rebuild. This document describes features and behavior, never implementation. It supersedes Draft v3 and incorporates the complete feature inventory.

---

## 1. What PlotRoom is

PlotRoom is a **context-authoring canvas for operating a fleet of AI agents**. A single operator composes context — tickets, pull requests, documents, files, notes, and the outputs of prior agent work — as a spatial node graph, wires that context into commands, and runs any number of agent sessions against it simultaneously.

The product serves two tempos of the same act:

- **Authoring, at rest.** Compose the context an agent will work from, deliberately, before anything runs. Wire entire multi-stage topologies — this command's output feeding that command's input — before spending a cent.
- **Steering, in flight.** A dozen sessions running at once. See the whole field, know which one needs you, answer it in five seconds, redirect any of them — without thirty seconds of transcript re-reading per interruption. This is the originating problem, and the product is judged against it.

These are not two features. Steering _is_ context authoring at a faster tempo: every mid-flight intervention becomes content on the graph, so the graph remains a complete record of what every agent knows.

**What PlotRoom is not:** a workflow builder. There are no triggers, no schedules, no conditional branches, no loops. The agent is better at conditionals than a graph is; every branch drawn is judgment taken away from the thing that is good at judgment. Edges mean exactly two things — _this content is in that prompt_ (context) and _this run produced that thing_ (provenance) — and nothing else.

---

## 2. Governing principles

These are constraints, not features. Every capability in this document operates inside them, and a proposal that violates one is an amendment to the product's thesis, not an addition to it.

1. **Intent is authored — and no agent authors intent into its own chain.** Context edges are decisions about what a session knows, and they are always someone's deliberate act: a human's, anywhere on the graph, or a session's, for sessions **outside its own initiation chain**. A session may not author intent into itself, its ancestors, or its descendants — it cannot wire its own inputs, grant itself capabilities, raise its own budget, or route around any of this through a chain it started. (A delegation's result returning to the delegator is not this: the delegator authored that intent when it delegated. Nor is a broadcast that happens to reach the sender's chain — a broadcast names a scope of shared material state, never a recipient, §6.5.) Sessions outside each other's chains exchange context freely — that is collaboration, bounded by budgets and watched by health alerts. Every authored edge records its author — human or session — so the graph shows not just what agents know but _who decided they'd know it_. Provenance edges are recorded automatically, never authored. A plugin's tool acts as the session that called it; plugins author no intent of their own. Where the target of authoring includes the author itself — a standing instruction that applies everywhere, a default derived for its own parameters — the agent **proposes and a human accepts**; a proposal is confirmed, never applied silently.

2. **Spend is budgeted, not gated — and the system never originates work.** Agents run, delegate, and spend as the work requires, inside **optional budgets** at run, workstream, and global scope. A session can see what remains of the budgets that bind it and plan accordingly; reaching a cap cuts work off as its own distinct outcome. What stays prohibited is the _product_ starting work with nobody behind it: no triggers, no schedulers, no timers that resume sessions, no automatic re-runs — a question whose default proceeds on a timeout is the system spending, and is out. Every running session's chain of initiation terminates at a human gesture, however many agent decisions sit in between. **Scheduled reads are fine; scheduled runs are not** — refreshing an integration on an interval changes state and costs nothing, and the change surfaces as something wanting attention. "Check this every morning" is expressible: a scheduled refresh plus a decision.

3. **Completion is proven, not claimed.** Whether work got done is decided by checking the world — an artifact exists and validates, a pull request is open, checks are green — never by an agent's own statement that it finished.

4. **Isolation is a guarantee, not a convention.** Concurrent work cannot corrupt other concurrent work's material state. Between workstreams, the guarantee is exclusive workspaces (§3.4); within a workstream, it is **path claims**: one writer per path, always (§3.4). The model enforces both; neither depends on discipline.

5. **The graph is a complete record of what agents know — and there is never an invisible session.** Anything that influenced a session — typed at it by a human, injected by a peer session, delegated to a child — appears on the graph as content and edges. Every session the product runs appears on the graph; there is exactly one way to start one, and it is in the app. (What some other tool runs in the same directory is outside the product — accepted, not prevented; its effects arrive honestly, as workspace divergence.) The picture is never missing an input or an actor.

6. **Nothing appears on the canvas that nobody put there.** Discovery makes things _available_; a human or agent gesture makes them _present_. No scan, poll, or inference places a card.

7. **Derive from observation, never from inference.** The product does not guess at what an external process is doing from indirect signals. If it cannot observe something exactly, it does not claim it.

8. **Agents and the UI are peers — with one enforced asymmetry.** Every gesture a human has is available to an agent as a tool, over the same vocabulary, so the two surfaces cannot drift apart and there is no privileged mode. The asymmetry is _reflexivity_: a session may author context, dispatch commands, and spend budget in service of other work, but nothing it does may expand its own knowledge, capabilities, or budget without a human (principle 1) — and destroying authored state goes through approval (§6.6). What an agent may not do is enforced, not merely undocumented.

9. **One gesture creates one thing.** A retry, a reconnect, or a double-click can never produce two sessions, two workspaces, or two runs for one request.

10. **Deletion is recoverable** for authored state — the arrangement and the topology are authored work nobody can recreate — including when an agent did the deleting.

11. **Failure is bounded and reported.** Nothing retries forever, nothing spends without a ceiling, and a thing that gave up says why — distinguishing _it did not work_ from _it was stopped_ from _it ran out of budget_.

12. **Never silently truncate content.** A truncated context is a wrong answer with no evidence. The product warns, or caps by explicit choice, and never quietly drops.

---

## 3. The model

### 3.1 First-class concepts, and who fills them

The core product defines a small set of generic concepts. **Integrations do not add concepts; they populate the ones that exist.** A Jira ticket is not a first-class thing — a _ticket_ is, and a Jira integration knows how to produce tickets from Jira. This is what lets every surface render concepts rather than connectors.

- **Ticket** — a unit of requested work: identity in some external system, summary, status, type, assignee, a link out.
- **Pull request** — a proposed change under review.
- **Review** — someone's judgment of a proposed change, with its comments.
- **Document** — a durable piece of prose: a spec, a plan, a design note, a file's contents.
- **Diff** — the current uncommitted state of a workspace.
- **Commit** — a recorded change.
- **Note** — human-authored content created directly in the app (§3.8).
- **Transcript** — the record of a session, usable as content like anything else.
- **Collection** — a set of any of the above, presented as one thing with a count. A collection is one node with one output; a change to its membership or to any member is a change to the collection. **A collection's verb is inspection**: it expands, its members are individually draggable out onto the canvas, and what the human doesn't drag out stays inside. This is how an epic becomes workstreams with no control flow anywhere: the epic's children arrive as a collection, the human expands it, prunes it, and drags four tickets out — each one a gesture that can open a workstream. The gate is a gesture, not a mechanism.

**Concepts are present or absent, never degraded.** There is no "this ticket source is unavailable" state in the core model. If no integration produces tickets, there are no tickets — no surface renders a half-working connector.

**Every concept has an identity that survives.** An object from outside carries the external system's identity, so re-reading reconciles rather than duplicates.

### 3.2 Content, scope, versions, and drift

Every object on the graph has **exactly one output: its content, prepared for agent consumption.** Each concept renders three ways — a card, a compact summary, and agent-ready content — supplied by whatever produced it.

**Scope.** A **world** object (ticket, pull request, review, published output, standing instruction) lives at top level and can be context for many workstreams. A **local** object (diff, transcript, tool output, note) belongs to the workstream that produced it. Locality is a default, not a definition: any local object can be **promoted** to world scope in one gesture.

**Versions.** A change to an object's content — a re-synced ticket, an edited note, a new run's output — produces a new version. **Retention is a rule, not an accident:** every version referenced by any run's history is retained; unreferenced intermediate versions are compacted after a configurable window; a pinned run and everything it references is never compacted. This rule bounds _connector churn_ — the sync-every-five-minutes noise — and only that; run history is bounded by its own rule (§4.4). Nothing is retained forever by default and nothing referenced is ever lost — both deliberate.

**Changes arrive as what's new, not just new state.** "Four new review comments arrived" is smaller and more actionable than a re-rendered pull request. Every kind of content can express itself as a delta against an earlier version of itself; where a change is larger than the content, the full content stands in.

**Drift.** When content changes after work consumed it, everything that consumed the old version is flagged **drifted** — transitively, per consumer, across workstreams. Drift is how the world talks to the board: a review lands overnight, and by morning the board _knows_, though nothing has run and nothing will until a human decides. Drift is a state, never an action.

**Objects you placed survive their source.** The last-known content of anything on the canvas is retained, so a card still draws after a restart or when its query no longer returns it — bounded by what you placed: a record of your choices, not a cache of the world.

### 3.3 Workstreams

The container between "a node" and "the graph." One workstream holds one piece of work — its work item, its workspace, its context topology, its commands, sessions, and local objects — and does four jobs:

| Job                  | Consequence                                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| **Identity**         | The cluster is about _OXY-2982_, not "session 7." Fleets become legible.                              |
| **Isolation**        | One workspace per workstream, owned exclusively (§3.4).                                               |
| **Zoom boundary**    | Collapsed: one card you scan — identity, status, progress, spend. Expanded: one topology you compose. |
| **Attention rollup** | Everything inside aggregates to one status on the card.                                               |

**Lifecycle:** active, done, abandoned — plus an **archive** gesture. **A workstream's subject is authored** — dragging a ticket in gives the container its identity — and a subject-less scratch workstream is legal. **Lifecycle states are authored too:** the human sets them; the product _suggests_ done when every producing command has completed — or, for a workstream of only open work, when every session has ended and nothing is drifted — (a proposal, confirmed like any other); an agent may propose a lifecycle change for a workstream outside its chain. Archived workstreams leave the board and remain searchable, reported as archived rather than hidden — and archiving, like every operation on authored state, is recoverable. Without this the birds-eye view degrades at exactly the rate the product succeeds: sixty containers of which forty are finished is a junkyard, not a control tower.

**Scope rule:** objects cross workstream boundaries (as world objects); commands and sessions never do.

### 3.4 Workspaces

A workspace is where work physically happens. One workstream owns exactly one workspace; workspaces never cross workstreams. The _boundary_ is guaranteed by the product; the _mechanism_ is supplied per workspace kind (a branch and checkout for a git repository; possibly nothing for a docs-only workstream), and new kinds can be added (§10).

**Path claims — one writer per path.** Write access to a workspace is granted **per path**. A session claims a file or directory, writes inside it until it yields, and while a path is claimed no other session may claim it — later claimants join a visible waitlist. Claims are system-managed; sessions get tools to request, yield, and inspect them. The single-writer arrangement survives as the default special case: a workstream begins with one session holding the **root claim**, and every claim is a subdivision of a claim someone already holds. One mechanism, no second concept. Non-claiming sessions read the workspace freely and produce content on the graph — analysis, findings, review notes — they just cannot touch files they hold no claim on.

The mechanism's rules, each of which comes up in the first week of use:

- **Conflict is hierarchical.** A claim conflicts with any claim on an ancestor or descendant of its path — `src/` and `src/auth.ts` conflict. Claims cover paths that do not exist yet, and a directory claim covers everything created under it.
- **Grant authority follows the path hierarchy, not lineage.** You may grant within what you hold: the workstream is the root holder, whoever holds a path may grant sub-claims inside it, and the human may grant, revoke, or force-release anything. Two unrelated sessions in one workstream both claim from the root holder with no special case.
- **Pre-granted claim policies make it economical.** A holder can declare policy — _children may claim freely under `src/`; never grant anything under `migrations/`_ — so interactive approval is the exception, not the mechanism. Without this, a twenty-file change costs twenty paid round trips to a parent that must be awake; correct and unusable.
- **Claims are leases, not locks.** A claim expires without activity and is renewed by it; a session ending releases everything it held automatically (explicit yield is an optimization); the human can force-release any claim — the escape hatch when a holder is wedged and its grantor is too.
- **Deadlock is detected, not endured.** A holds `src/api/` and waits on `src/ui/`; B holds `src/ui/` and waits on `src/api/`. The claim manager detects the wait-for cycle and refuses the newest claim with an actionable message — _granting this would deadlock; you hold `src/api/`_ — rather than letting two sessions sit forever.
- **Waiting on a claim is an attention state** — a session phase (§3.6), a health alert past a threshold, and part of blocked-on accounting (§7.2). A waitlist nobody can see is a new invisible stall, the exact failure the product exists to prevent.

**Why this is consistent with principle 1, stated because it looks like it isn't:** a child asking its parent for write access reads like a chain granting itself capability. It is not — **a claim can only be granted from capability the granter already holds. A claim redistributes write access within a chain; it never creates any.** If the workstream's root claim came from a human, every claim downstream is a subdivision of that one grant, and no chain can acquire reach it was not given.

Claims also sharpen two things for free. **Divergence becomes precise:** a session's picture is stale if a path it read was written by a different claim holder — not "the workspace changed somehow" — so continuation is blocked far less often and always for a reason the product can name. **The operator is an implicit claim holder:** a human editing files alongside sessions is the normal case, not an anomaly, so hand edits are a named divergence class of their own — they stale a session only when they touch paths that session read, never wholesale. Without this, co-working with an agent in one workspace would torch every session's continuability on the first keystroke. And **conflict prediction gains an intra-workstream form:** overlapping waitlisted paths are a real, cheap signal, and cross-workstream prediction reuses the same path vocabulary.

- **Provisioning.** Creating a workstream creates its workspace. For git: a branch, named from a configurable template (ticket, project, repository, title slug). An existing branch is never renamed or re-derived; a branch that exists remotely is taken from the remote, so a checkout of someone else's branch has that branch's actual commits.
- **Readiness, not just existence.** A fresh checkout has no installed dependencies, so nothing can be verified in it. A workspace has a **ready** state: a declared per-repository setup step runs after creation and before anything may run there. Not-ready blocks work with the reason visible; setup output is inspectable; a failed setup is reported rather than silently producing failures downstream. The setup declaration lives with the repository where possible — traveling with the code, reviewable — with a settings override for repositories you cannot commit to.
- **Live status.** Current branch, uncommitted changes, ahead/behind — kept current so a change made by any session _or by a terminal_ is reflected everywhere it is shown.
- **Divergence detection.** The product can tell when a workspace changed outside a session — a rebase, a merge, moved files — which is what makes it safe or unsafe to continue an earlier session (§4.3).
- **Workspace authentication is the host's.** Git operations inside a workspace — fetch, push, clone — use the machine's own git and SSH configuration: the backend machine's, when the backend is remote (§12). **App-held credentials are never used for workspace git operations and never written into a workspace's git configuration or remotes** — an integration token embedded in a remote URL would be readable by any session in that workspace. A clone the host cannot authenticate fails honestly, with the reason, rather than falling back to an app credential.
- **Discovery and lifecycle.** Configured search paths are scanned so repositories are found, not only declared; a discovered repository is available but places nothing on the canvas. Workspaces can be created, attached, removed, and force-removed when uncommitted changes exist. The primary checkout and the default branch are protected and never removable. A repository known only from a pull request can be cloned from its card — over the host's own git authentication, never the integration's token; if the host cannot clone it, the card says so.
- **Cost awareness.** Provisioning per unit of work is expensive in time and disk; the product reuses shared caches where a workspace kind can, and reports what provisioning cost.

### 3.5 Commands

A command is **a named, reusable set of marching orders**: the instruction, the model and effort, the tool permissions, what it expects to produce, and where the user wants to be asked. The spec distinguishes:

- **Command definitions** — reusable, editable content, not code. Created, duplicated, and organized by the user; shipped first-party in the box for the common paths; shippable inside plugins.
- **Command nodes** — an instance on the graph: a definition plus its wiring. Dragging a definition onto a target (a ticket, a workstream) instantiates a node with the target wired as context. A command with no parameters must be usable in one gesture.

**Parameters.** A definition may declare inputs it asks for when used, so a reusable recipe does not hardcode values wrong in every other repository. Defaults may be suggested where honestly derivable from the target — a proposal the user confirms, never a guess applied silently.

**The most common gesture, stated.** Dropping a command definition onto a bare ticket at top level **creates a workstream** — the ticket becomes its subject, the command node lands inside with the ticket wired as context. The workstream exists in the same instant as the gesture; **the workspace is provisioned at first run, not at creation** — a gesture is 200ms, provisioning is 90 seconds of paid setup, and the run preview is where that cost belongs. The readiness gate (§3.4) already governs the interval between.

**Two lifecycles.**

- **Producing** — declares an expected outcome: a named, typed object, optionally with structure, and optionally **world conditions**: predicates checked against the outside world ("a pull request exists," "checks are green"). The session ends when the outcome is submitted _and_ the conditions hold. **A submission whose conditions fail is rejected, with the failing condition returned as feedback, and the session continues — bounded by its budget.** World conditions are a loop the agent can close, not a trapdoor; "checks are green" is false for legitimate reasons all the time, and the useful behavior is telling the agent which check and letting it fix it. Completion is proof, not a claim — this is what makes a collapsed card's progress trustworthy. **Proof is point-in-time:** completion is proven at submission and never silently revoked. A condition that regresses afterward — checks turn red an hour after the session ended — surfaces as drift and attention on the done work, and a human decides what happens next; nothing re-opens or re-runs on its own (principle 2).
- **Open** — no declared outcome; ends when the user ends it. "Figure out why the build is flaky" has no knowable output shape, and that is a lot of real work. Open work feeds downstream by promoting something it produced or by wiring its transcript — a dead end only until a human names what it found, which is principle 1 doing its job.

**Context inputs are ordered.** Edge order is the order content is assembled for the agent, and it is rearrangeable by drag.

**Output pre-wiring.** A producing command's output exists _before any run_ as a typed placeholder, and can be wired as context into other commands. This is what makes PlotRoom authoring rather than watching: compose the whole topology, then run pieces in any order. After a run, the output binds to what was produced.

**Published outputs — the two-state rule.** An output can be **published** (made world-scoped, pre-run), letting commands in other workstreams wire to it. This is the product's only cross-workstream dependency, and it has two states: **pre-bind**, the wire is a promise — downstream is visibly blocked on a command in another workstream, and deleting that command leaves a visibly broken placeholder, never a silent unblock; **post-bind**, what crosses is the produced object, promoted to world scope — the command dependency evaporates, and deleting the command afterward leaves the object intact. **Publish and promote are two verbs**: publish marks a placeholder before a run; promote lifts an existing object after the fact.

**Content budget.** Assembly warns when content approaches the model's window; a hard cap is opt-in per command; the product never silently truncates (principle 12).

### 3.6 Sessions

A session is a live or completed agent run inside a workstream — and **a record the product owns**: readable, resumable, forkable, deletable, always. There is no distinction between a live session and a stored one, and no read-only mode.

- **Phases**, derived continuously and shown everywhere a session appears: thinking, responding, running a named tool, compacting, waiting for approval, waiting for input, waiting on a claim, stopped, failed, idle. Each phase carries whether the session is busy and whether it wants attention. (Phases derive from events the runtime emits about itself — that is _observation of the runtime_, consistent with principle 7. What stays untrusted is an agent's claims about the world: those are proven, never believed — principle 3.)
- **Per-session choices**, made at launch and visible after: model and effort, tool permissions (a session can be launched narrower than the app).
- **Accounting per session**: turns, elapsed, tokens, cost, time since last activity — plus a context-window meter with warning thresholds.
- **End states**: a producing session ends on proven completion; an open session when the user ends it; any session by stop, by unrecoverable failure, or by **running out of budget — its own outcome, distinct from failure.** The work did not fail; the money ran out. A different thing to a human reading the card, and something a retry must not blindly re-run.
- **Delegation.** A session may delegate to child sessions — and, more generally, may author context for and dispatch work to other sessions (principle 1). Every delegated or dispatched session is visible on the graph with its provenance, never hidden inside a tool call; its spend counts against every budget that binds the initiating work (principle 2).
- Sessions persist; **the transcript is content** like anything else, wireable as context, with its delta being its new turns. **A live transcript versions on checkpoint, not on every turn:** a wired transcript that drifted its consumers per turn would bury the drift feed in noise (§4.5); its consumers drift when the session ends or when someone — the session included — explicitly checkpoints it.
- **Interruption is honest.** A crash or restart with sessions in flight reports each of them as **interrupted** — a distinct end state alongside stopped and failed (principle 11): the work did not fail and nobody stopped it. An interrupted session is a session like any other — readable, resumable, forkable — and resuming it is a human or agent gesture, never automatic (principle 2).

### 3.7 The graph itself

- **Context edges** carry content into a command — or into a _running session_ (§6.5): the same act at a faster tempo. Every context edge records its author, human or session (principle 1).
- **Provenance edges** are recorded as work happens: command → session, session → what it created, and session-to-session relationships **recorded with meaning** — a fresh sibling, a fork of a transcript, a handoff seeded with a brief. Only transfers of context create a provenance relationship.
- No cycles in **command topology**: a command's output cannot be, transitively, its own input. This rule is about commands, explicitly not about running sessions — session ↔ session injection is legitimately bidirectional (§6.5), governed by the lineage rule and budgets, not by acyclicity.
- **The legal connections, exhaustively:** content → command, and content → running session. Nothing else. This is the list the mid-drag refusal (§5) enforces.
- **Run history** records, for every run: exactly what went in (the assembled content and its versions, in order), the configuration it ran under, what came out, and what it cost. This is what makes any two runs comparable for as long as both are retained (§4.4) — history that recorded less would leave runs uncomparable even while retained, and **pinning is how a run becomes comparable forever**.

### 3.8 Notes and standing instructions

- **Notes** are human-authored content created directly in the app — the fastest path from a thought to something on the graph — and **editable**: a note you cannot edit is not a note. Editing extends to promoted content; each edit is a new version, drifting consumers like any other change. (A full editor for files and documents is directional, §13.)
- **Standing instructions** are content marked as applying everywhere — "this repository uses pnpm, never npm," "never touch the generated directory" — available as context to every workstream that wants it, so parallel sessions stop rediscovering the same facts at a paid turn each. **Agents can propose additions; a human accepts them** (principle 1).

---

## 4. Running work

### 4.1 Initiation and scope

Work is initiated by humans — and by sessions acting on other work, within budget (principles 1, 2). The system itself never initiates. Every run gesture below is equally available to a session as a tool, subject to the lineage rule: a session cannot run, resume, or re-run itself or anything in its own initiation chain. One initiation may cover:

- **Run one** — this command.
- **Run subgraph** — this plus everything downstream that becomes runnable, in dependency order. It **pauses** on a failed or out-of-budget session — resumable once the human addresses it — and a user **stop aborts** the remainder rather than pausing it: stopped means stopped.
- **Run what's missing** — the run affordance never disables; a blocked command shows _waiting on: …_ and offers to reveal and run the upstream chain that would unblock it, asking once.
- **Re-run all drifted** — within a workstream, or fleet-wide.

**Every scoped run previews exactly what it will execute and what it may cost before it starts, and accepts a spend cap.** This is how "hand off and walk away" works with no scheduler anywhere in the product. **A cost estimate states its basis and its uncertainty** — "based on 12 prior runs of this definition," or "no history; input size only" — and renders as a range, never a bare number: an authoritative-looking wrong number is worse than an honest one (principle 7 applied to the product's own predictions).

**The concurrency limit.** A configurable global limit bounds how many sessions run at once. Initiation beyond it **queues**: a queued run is visible as queued, shows its position, and can be cancelled before it starts. Queuing is admission of already-initiated work, not scheduling — the human (or session) gesture already happened; the system is only deciding _when_, never _whether_. With agents able to fan work out, this went from a nicety to load-bearing. **The preview is the contract:** a queued run executes exactly what it previewed, and if its inputs drifted while it waited, it says so and asks rather than silently running something else.

### 4.2 Batch gestures

A multi-selection of sessions supports one prompt to many, stop, close, and archive — with configurable preset prompts for the recurring ones.

### 4.3 Continue or start fresh

Re-running a command is an explicit choice between two modes, and the product makes the trade visible rather than deciding silently:

- **Fresh** — a new session, full context assembly. For _"that was wrong, start over."_
- **Continue** — the existing session picks up with what changed since, delivered as a new turn. For _"the world moved, react to it."_ Continuing a live session is always the cheap path. Continuing a completed session means bringing its whole history back, which can cost more than starting over — so the run preview shows the cost of both options side by side, and the human chooses.

Two things gate continuation regardless of preference: the combined content must fit the model's window with headroom, and **workspace divergence forces fresh** — if the workspace changed outside the session (a rebase, a cross-merge, moved files), the session's mental picture is stale in a way no update can repair, and the product says so rather than letting a confused continuation spend money.

Each command carries a default mode; a third mode — continuing from a _summary_ of the prior session — is a recorded intention (§13).

### 4.4 Run history, pinning, and comparison

Every run of a command is retained and addressable. Downstream consumers follow the **newest by default** and can be **pinned** to a specific run. Adjust → re-run → compare is the most-repeated action in context engineering, and the product makes it first-class: compare two runs of the same command — what went in, what came out, which model, what it cost. **Cross-run outcomes** aggregate across many runs of the same definition — how many attempts it typically takes, what usually fails, what it costs — which is how _"is delegating this kind of work actually working?"_ becomes answerable.

**Run history has its own retention rule** — it is the largest store in the product, and "forever" would collide with principle 11 and with §12's portability promise: the last N runs per command definition, plus every pinned run and everything it references, plus everything inside a configurable window. Pinning is the human's word for _never compact this_.

### 4.5 Living with drift

Drift arrives constantly on a busy board, and a feed you learn to ignore is worse than none — it takes about three false positives. Every drift flag (and every other attention feed, §7) supports the triage verbs: **acknowledge** (seen; the consumer's baseline advances without running anything — a typo fix on a ticket shouldn't cost eight decisions), **snooze** (bring it back later), and **mute** (never show this one again).

---

## 5. The canvas

The graph is the primary surface. Everything else — the queue, the palette, search — is a lens over the same state, never a second data model.

- **Selection is the route.** The selected node is reflected in the address; a refresh or shared link lands on the same node with its panel open. There is one navigation primitive, and every entry point uses it: a click, the command palette, the attention queue, a deep link.
- **Rigid-body arrangement.** Nodes are solid rectangles that never overlap. Pushing one pushes what it touches, and the push travels through a chain. No attraction, no repulsion at a distance, no continuous simulation — an arrangement at rest stays exactly where it is until something moves it.
- **Placement is durable**, including across restarts. Arranging by hand never costs an earlier placement — "never costs" constrains _automatic_ layout, which never runs uninvited; a rigid-body push is part of the human gesture that caused it, and undoing the gesture restores what it pushed. An **initial arrangement is derived** from the graph's structure so a new node appears somewhere sensible; **reset arrangement** is the only automatic-layout verb, and it re-derives from structure.
- **Zoom levels carry meaning.** Zoomed out: one card per workstream — identity, status, progress, spend. Mid-zoom: the nodes inside. Zoomed in: full detail of what happened. This is what keeps a dozen concurrent workstreams legible on one surface. Containers collapse and expand; edges into a collapsed container draw to its frame.
- **Authoring gestures.** Drag an edge to empty canvas for a create menu filtered to what that edge could legally connect to. Illegal connections are **refused while being dragged**, not after they land — an illegal connection never looks like a legal one.
- **The palette** — a rail of everything _not yet_ on the canvas, as drag sources: tickets, pull requests, reviews, documents, past sessions, command definitions. Ticket rows are ordered so the top one is always something nothing else is blocking.
- **Speech bubbles attributed to their sender.** A message draws as a bubble on the node that produced it — a command shows the prompt it dispatched, a session shows what it is saying, a tool in flight shows as a distinct chip. Attribution is the point: on a canvas where several nodes drive one conversation, _who said this_ is the thing worth knowing. Bubbles never obscure the minimap or controls, never exceed the width of what they attach to, collapse to a count when a node is unfocused, and cap how many show at once — fifteen sessions must not become a comic strip.
- **Off-screen attention markers** — a pointer at the canvas edge aimed at any node wanting attention outside the view, clustering with a count, withdrawing the moment the node scrolls into view.
- **Minimap, legend, live counts. Multi-select** by marquee or modified click, with a contextual bar of the actions that apply to the whole selection.
- **Undo for destructive operations** — deleting a workstream, clearing a region, removing nodes or edges — including when an agent did the deleting (principle 10).
- **Graph warnings, never refusals.** Topologies that are legal but probably wrong are flagged on the card and in the editor: a chain that cannot run because nothing upstream has produced its input, content assembled beyond the model's window, a command with no context at all, a published output nobody consumes, an unreachable node. **Warnings are readable by agents too**, so a session that produced a mistake can see and fix it in the same turn. Impossible things are refused; questionable things are flagged — a check that blocks authoring is a check people route around.

---

## 6. Working with sessions

### 6.1 The transcript

Streaming responses; reasoning rendered distinctly from output; tool calls with their inputs and outputs; message-level actions; export to a portable document. **Bounded transcripts with recoverable release:** a long-running session's transcript stays within a size budget by releasing the largest old tool outputs first, with a visible marker where content was released and a way to load it back. Nothing is silently deleted, and an export of a released transcript is complete.

### 6.2 Drafts and history

An unsent message and the recallable prompt history survive closing the panel and switching away, per session.

### 6.3 Resume, fork, and handoff

Continuing a session is an **explicit choice between resume and fork** — never an implicit consequence of typing into it. A **fork from any point** inherits the conversation up to that point and gets its own workstream and workspace, so two lines of work can diverge from shared understanding. The product marks the points where a session touched the outside world, because a fork before such a point is clean and a fork after it is not. A **handoff** seeds a new session with a brief the source session writes itself and the user edits before sending.

### 6.4 Structured questions

A session can ask the user a question with selectable options; the answer returns to the session as a result rather than prose it has to interpret. Options not picked remain visible as paths not taken. Questions render as bubbles on the session node, answerable inline without opening anything. **No question may carry a default that proceeds on a timeout** (principle 2).

### 6.5 Injection and broadcast

Content added to a running session mid-flight arrives as a new turn — and as content on the graph, wired to the session, permanently (principle 5). _"The answer is in docs/architecture.md, stop grepping"_ is one gesture, and it leaves a paper trail because steering is authoring. **Injection is a peer gesture:** humans inject, and sessions inject into _other_ sessions — a researcher session handing a finding to the implementer that needs it — attributed either way, on the graph either way. This is how agents talk to each other: through the graph, never around it. (One consequence is accepted rather than closed: a session that may not author into its own chain may _ask_ an out-of-chain peer to do so, and the peer legally can. The request is an injection and the wiring is an authored edge — both on the graph, both attributed — so the laundering is auditable, bounded by budgets, and visible to the operator; a channel this shape cannot be closed without also closing legitimate collaboration.) **Delivery is not instantaneous:** a runtime may only accept input between turns, so an injection during a long tool call shows as **queued** until **delivered** — otherwise the first "stop, that's wrong" that lands ninety seconds later reads as a broken feature. **Broadcast** delivers the same content to many running sessions at once — and who may send one shapes what it is:

- **Human broadcast is unconstrained** — a selection, a workstream, everything currently executing on the graph. The operator is the authority the whole system terminates at.
- **Session broadcast names a scope of shared material state, never a recipient.** _"Everyone in this repository," "everyone in this workspace"_ — a material fact the system evaluates, not a chosen list. This exists for real emergencies — a session that rebased a shared branch needs everyone in that repository to know — and the scope rule, not lineage exclusion, is what closes the collusion channel: a broadcast cannot be a covert wire to your own parent when you do not choose who receives it and everyone in scope gets the same thing. (Excluding the sender's chain would exclude exactly the sessions most likely affected.) A session broadcast additionally carries a **mandatory declared category** — _material state changed under you_, _shared resource warning_ — so it is auditable and cannot masquerade as task context: an emergency channel, not a general-purpose back channel.

Broadcast is the product's largest spend amplifier — one decision, twelve paid turns — so it is **bounded per session per window**, its **induced spend counts against the sender's budget chain** (the sender caused it; anything else lets a session spend from budgets that do not bind it, a hole in principle 2's transitive guarantee), and **the operator sees it**: a session-originated broadcast appears in the queue and in each recipient workstream's activity history. An agent telling twelve other agents something is exactly the class of event worth knowing happened.

### 6.6 Approvals

A session requesting a capability it does not have — a command to run, a write to an external system, a claim outside every standing policy — raises an **approval**, surfaced on every in-app attention surface and routed outbound (§7.3), answerable without opening the session. (Answering from the outbound route itself, rather than returning to the machine, is directional — §13.) Approvals can be **pre-granted** per session or per workstream — a human decision about capability made in advance, which is different in kind from a timer that spends. Destructive gestures against authored state requested by an agent go through this same channel. **Irreversibility pierces pre-grants:** every integration write action declares whether it is reversible (§9.2), and an irreversible one — merge, force-push, delete — always raises an approval regardless of what was pre-granted. The same declarations are what mark where a session touched the outside world (§6.3), so fork-cleanliness comes from the source of truth rather than a heuristic.

### 6.7 Stopping

Stop at three scopes — one session, every session in a workstream, everything running. A stop names how many it will affect, is disabled when nothing is running, and confirms at the widest scope.

### 6.8 Search and archive

Search spans every session, including archived ones, ranked over title, location, and content; archived sessions are reported as archived rather than hidden, because finding them is the point. **Archive by default:** a machine accumulates hundreds of sessions; the canvas holds the ones you put there, and everything else is browsable and searchable.

---

## 7. Attention and triage

**One derivation, many surfaces.** What each session needs is computed once and rendered everywhere: node state, off-screen marker, header indicator, window title, application badge, system notification.

### 7.1 The queue

A single ranked list of everything wanting a decision, keyboard-driven, where each row carries enough context to answer _without opening anything_. Selecting a row moves the canvas to it — the queue is a lens, not a place. Fed by: unanswered questions, pending approvals, drift, health alerts, and completions. Every feed supports acknowledge, snooze, and mute (§4.5) — without triage verbs, the queue becomes the inbox you cannot clear, which is the failure it exists to prevent.

### 7.2 Health alerts

Derived from observation, never reported by the agent:

- **Idle** — no output for too long.
- **Spinning** — cost climbing while nothing in the workspace changes.
- **Conflict predicted** — overlapping paths, in either form: two active workstreams changing the same paths in the same repository (a merge conflict you will hit later), or overlapping waitlisted claims inside one workstream (contention you are hitting now). Same path vocabulary, both directions.
- **Unanswered** — a question or approval nobody replied to.
- **Blocked on you** — time a session spent waiting on a human — approvals, questions, claim grants outside policy — tracked separately from time spent working, so it is possible to see when the bottleneck is the operator. A claim wait past a threshold alerts on its own.

### 7.3 Away from the screen

The attention system cannot assume eyes on the canvas; the real failure is several agents blocked while you are at lunch. **Outbound notification routing** sends attention to destinations the user configures — a push service, a chat webhook — with the same edge-triggered discipline as the in-app surfaces and with sensitive content redacted. A route attaches to a _state_ ("anything blocked," "anything failed"), not to a node, so everything is covered without drawing anything. **What changed while I was away:** each workstream keeps a short, capped history of notable events — a pull request got comments, a ticket moved, work completed, a session failed — so returning tells you what _happened_, not just what is currently true. Each entry routes to what it was about and tolerates that target being gone.

---

## 8. Accounting and observability

- **Cost outlives the session that spent it.** Spend accumulates and persists per session, per workstream, and fleet-wide; totals do not reset when sessions end. Everything else here depends on this.
- **Spend surfaces:** on the session, rolled up on the workstream card, and a fleet view — today's total, the biggest spender, and running sessions against the concurrency limit.
- **Budgets at three scopes:** a single run or batch, a workstream, and a global ceiling. Budgets are the mechanism that makes agent-initiated work safe (principle 2): a session can see what remains of every budget that binds it and plan within it, and reaching a cap cuts work off as its own outcome (§3.6), distinct from failure, which a retry must not blindly re-run. A capped run previews what it will do and what it may cost before starting. **The product ships with a default global ceiling** — a real number the operator can raise or remove, not an empty field with a recommendation — because with agent fan-out, one gesture can otherwise authorize unbounded spend. **Near a cap, the defined behavior is to stop cleanly**: wrap up, report, leave the workspace coherent. Racing the budget — skipping verification to fit under it — is a failure mode, and the product's guidance to agents says so explicitly.
- **Session timeline:** where the time and money went, as a temporal view of turns and tool calls — including for finished sessions, so it is the post-mortem for something that failed overnight.
- **Run history and cross-run outcomes** as specified in §4.4.
- **Structured logs** with a consistent shape across the whole system, level adjustable at runtime, sensitive values redacted, viewable in the app.

---

## 9. Integrations

Integrations are plugins on the platform contract (§10) — installed, enabled, removable — and the product works without any of them. An integration **populates first-class concepts** (§3.1); it never adds new ones.

### 9.1 Reads and synchronization

Each integration declares how it refreshes — on an interval, on demand, or in response to something it observes. Manual refresh is always available, per integration and per object. A refresh that changes content bumps the object's version, which surfaces as drift wherever the object is used; nothing re-runs on its own. Changes arrive as what's new (§3.2). **Scoping is per integration and configurable at runtime** — which tickets, which repositories, expressed in the source's own query language and changeable without a restart, because the right query is discovered by trying queries.

### 9.2 Writes

**Write-back is a normal capability, not an exception.** Any integration may offer writes; each is available both as a UI action and as an agent tool (principle 8, subject to approvals), and **each declares whether it is reversible** — the declaration that drives irreversibility approvals (§6.6) and outside-world markers (§6.3). Shape by example: create, update, transition, assign, comment on a ticket; open, update, comment on, request review of, merge a pull request; submit a review with findings; create or update a document. **A write's result is read back, never assumed** — external systems have automation and workflows, so the state you asked for is not reliably the state you get; the product re-reads and shows what actually happened, including a rejection's own error text.

### 9.3 Authentication and health

Each integration owns its connection with a real in-app connect flow — not delegated to a command-line tool authenticated elsewhere. Connection state is visible; a broken or expired connection is an integration health problem, never mysteriously missing data. Credentials are stored by the app and exposed to no session and no other plugin.

### 9.4 In the box

Shipped as plugins on the same contract as any third party: **GitHub** (pull requests, reviews, issues as tickets, repository metadata, writes), **Jira** (tickets, epics and children, statuses and transitions, writes), **Filesystem** (files and directories as documents; browse and drag onto the canvas), **Coding/git** (workspaces, diffs, commits, branches — §3.4).

---

## 10. Extensibility

Everything outside the core model is a plugin, including what ships in the box, and the product owns the whole system: discovery, lifecycle, contracts, distribution.

### 10.1 What a plugin can contribute

Concept producers · write actions · agent tools (declared inputs, outputs, permission requirements) · content renderers (agent-ready content _and_ its delta against a prior version) · card renderers (compact and expanded, including in-canvas interactive surfaces) · panels · palette and command-palette entries · workspace kinds (with their own provisioning, readiness, and divergence rules) · condition checks (predicates for proving completion) · notification routes · command definitions · themes.

### 10.2 Lifecycle and trust

Install, enable, disable, remove — per plugin, without restarting. Plugin health is a first-class surface: connected, misconfigured, failing, out of date. **Declared permissions:** a plugin states what it needs — network, filesystem, which credentials, which core capabilities — and the user grants them; a plugin cannot silently gain reach. Versioning against a declared contract version, with refusal or warning rather than obscure failure. Distribution as a self-contained package: in the box, from a directory, or from a source the user configures. **Failure isolation:** a plugin that throws, hangs, or fails to load degrades to _that plugin being unavailable_, reported — never a product that won't start. **Plugins cannot author intent** (principle 1): a plugin produces content, offers tools, and renders things; it does not draw connections between them.

---

## 11. The application

- **A dock rail with a panel registry** — panels registered, including by plugins; one open at a time; closing is cheap because state persists. In the box: **Conversation** (transcript and composer for the selected session, with status, a session switcher, and export), **Diff** (a workspace's changes — file tree and patches, read-only), **Fleet** (spend and running work across everything), **Logs** (the structured log, filtered), **Timeline** (a session's turn-by-turn breakdown).
- **Command palette:** one keyboard entry point for navigation and every verb.
- **Keyboard access to the high-frequency verbs**, not just navigation: move through the queue, answer the selected item, run the selected node, stop the selected session. Every binding appears in a shortcuts overlay — a binding cannot exist undocumented.
- **Accessibility as a system property:** dialogs trap and restore focus; listboxes and comboboxes announce themselves; streaming text announces on start and completion rather than per token; every interactive surface is keyboard-reachable.
- **Settings:** grouped, searchable, applied without restart. Everything configurable is a setting; environment variables only supply defaults.

---

## 12. Platform and deployment

- **Local-first.** Runs as a desktop application and in a browser against a local server. Packaged installers for desktop platforms.
- **Single operator by design.** No accounts, no identity, no presence. Access control is an operator credential (an optional shared secret locally; real authentication required for a non-local backend) — not a user system.
- **Bound to the local machine by default**; remote access is expected to be tunnelled rather than exposed. The desktop application can also connect to a **remote backend** instead of starting its own, remembering and switching between backends. When the backend is remote, workspaces, diffs, and file browsing refer to the _backend's_ machine, not the operator's — the canvas is a window onto where the work lives.
- **All state is durable and portable.** The canvas, workstreams, sessions and their content, run history, settings — stored together, surviving restarts, backupable, movable.
- **Reset and cleanup:** clearing the arrangement, clearing derived state, or clearing everything — each stated separately, each saying exactly what it will remove before doing it.

---

## 13. Directional — recorded intentions, not commitments

- **Configure a node on the card itself**, rather than in a modal covering the graph being reasoned about.
- **Editing files and documents in the app** — a real editor beyond the note and promoted-content editing already in scope (§3.8).
- **Summarized continuation** — continuing a session from a summary of its prior work plus what changed: cheaper than full history, warmer than fresh.
- **Flakiness detection** for world conditions that pass and fail non-deterministically.
- **Answering from an outbound route** — approving, replying, or unblocking directly from the push notification or chat message, rather than being told at lunch and unblocked at the desk. Being unblocked away from the machine is half of the routing feature's own motivation.
- **A shared task list several sessions claim from.** (Direct messaging between sessions is not directional — it exists, as cross-session injection, §6.5. Any richer channel inherits the same constraint: it is content on the graph, per principle 5.)
- **Multi-root workspaces** — one workstream spanning two repositories (a frontend and a backend changed for one ticket). Today's answer is two workstreams coordinated by published outputs; the workspace-kind contract (§10.1) is written so a composite kind can exist without a new concept.

## 14. Non-goals

- **Workflow control flow.** No conditional branches, loops, or joins as graph structure — the agent is better at conditionals than a graph is.
- **Automatic re-execution.** Upstream change flags; it never re-runs.
- **Triggers and schedulers that start work.** Scheduled reads are fine (principle 2).
- **Inbound webhooks.** They require a publicly reachable address — the wrong trade for latency alone in a local-first tool. Integrations poll or observe.
- **Inferred relationships.** Guessing that two objects are related from a naming convention produced edges that were confidently wrong in the cases that mattered. Relationships are asserted. (Reconsidering later is open; it is not the plan now.)
- **A board or list view as an alternative organizing model.** Derived lists — the queue, the palette, search — are fine and necessary. A second way to arrange the same work is not.
- **Hiding whole categories of node.** A canvas that silently omits kinds cannot be trusted to be complete.
- **Multi-user.** Built once and removed; it added an axis to every surface for nobody's benefit.
- **A distinction between live and stored sessions.** Every session is readable and continuable.
- **Silent truncation.** The product warns, or caps by explicit choice, and never quietly drops.
- **Timed defaults on questions.** A timer that resumes a session is the system acting with nobody behind it — the one kind of spend principle 2 still forbids.

---

## 15. What must exist in the first cut

This document is a rebuild input, and four things in it are schema-shaped rather than feature-shaped: get them wrong at the start and every historical record is permanently degraded, because a rebuild will naturally do them second unless the spec says otherwise. Everything else in this document is additive. These are not:

1. **Run history records the full assembled content and configuration** — not just versions. A history that recorded less leaves every past run uncomparable forever (§3.7, §4.4).
2. **Every context edge records its author** — human or session. Retrofitting means every pre-existing edge has an unknown author, and the graph stops being able to say who decided what agents know (principle 1).
3. **Version retention with the compaction rule** — run-referenced versions retained, unreferenced intermediates compacted after a window, pinned runs never (§3.2). "Retain everything forever" is a decision either way; make it deliberately.
4. **Per-run output addressing** — _latest_ as a special case of a general address, never the only case (§4.4). A system built on "the output" instead of "output@n" cannot grow comparison later.
