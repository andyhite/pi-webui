# Canvas node inventory — designer reference

What renders on the PlotRoom canvas, every attribute each node carries, and
whether that attribute is something the operator edits or something the system
derives. Compiled from `packages/core` (source of truth for attributes) and
`packages/ui/src/canvas/PlotCanvas.tsx` (the current unstyled mechanics —
i.e. exactly the design gap).

**Legend**

| Mark            | Meaning                                                  |
| --------------- | -------------------------------------------------------- |
| ✏️ **editable** | The operator can change it (directly or via a gesture)   |
| 🔒 **innate**   | Fixed at creation; never changes                         |
| ⚙️ **derived**  | Computed/observed by the system; never directly editable |

Four node types render on the canvas, plus a shared overlay layer every node
can carry.

---

## 1. Content node (object card)

One node type, **nine kinds** — each kind needs its own card design:

`ticket` · `pull_request` · `review` · `document` · `diff` · `commit` ·
`note` · `transcript` · `collection`

A core rule (spec §3.1): integrations populate these kinds, they never add new
ones. A Jira ticket is not a first-class thing — a _ticket_ is.

| Attribute                                                 | Class      | Notes                                                                                                                                         |
| --------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Kind                                                      | 🔒         | Set by whatever produced the object; never changes                                                                                            |
| External identity (`system` + id, e.g. "jira / OXY-2982") | 🔒         | Only on objects from integrations; re-reads reconcile by it rather than duplicating                                                           |
| Title                                                     | ⚙️ / ✏️    | From the producer for external objects; typed by the operator for notes                                                                       |
| Content (current version)                                 | ⚙️ / ✏️    | Re-read from source for external kinds; **notes are the editable exception** — each edit writes a new version (identical content writes none) |
| Card rendering / one-line summary                         | ⚙️         | Supplied by the producer (`Renderings`: card data, compact summary, agent content)                                                            |
| Scope: world / local                                      | ✏️ gesture | Local by default; "promote" lifts to world scope in one gesture, one-way                                                                      |
| Version history (ordinal, summary, timestamp, author)     | ⚙️         | Every version records who authored it (§15-2)                                                                                                 |
| Pinned version                                            | ✏️         | Pinning exempts a version from compaction                                                                                                     |
| Drift flag ("this changed since it was wired")            | ⚙️         | Never editable, only acknowledgeable                                                                                                          |
| Content delta ("4 new review comments")                   | ⚙️         | Kinds that can express a change against a prior version show the delta instead of re-rendering everything                                     |
| Position on canvas                                        | ✏️         |                                                                                                                                               |

> **Provisional:** `collection` has no membership model yet (recorded open
> decision). Design the collection card knowing its child list representation
> may change.

---

## 2. Command node

The card is a **definition plus its wiring**. Almost everything on it is
editable — this is the most form-like node on the canvas.

| Attribute                                                            | Class        | Notes                                                                                                                                                                                                                               |
| -------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name                                                                 | ✏️           |                                                                                                                                                                                                                                     |
| Instruction (prompt)                                                 | ✏️           |                                                                                                                                                                                                                                     |
| Model + effort (`low` / `medium` / `high`)                           | ✏️           |                                                                                                                                                                                                                                     |
| Tool permissions (allowed / denied)                                  | ✏️           |                                                                                                                                                                                                                                     |
| Ask points                                                           | ✏️ partially | `irreversible_write` is always on and cannot be removed                                                                                                                                                                             |
| Lifecycle: `producing` vs `open`                                     | ✏️           | Producing **must** carry an expected outcome; open **cannot** — schema-enforced. The card should make this pairing visible                                                                                                          |
| Expected outcome (name, kind, completion conditions)                 | ✏️           | Producing commands only                                                                                                                                                                                                             |
| Parameters (name, label, type: string/number/boolean/enum, required) | ✏️           |                                                                                                                                                                                                                                     |
| Parameter binding state: `proposed` vs `confirmed`                   | ⚙️ then ✏️   | A proposed value is derived (and shows _what it was derived from_); the operator confirms it. **The two states must look different** — a run refuses while any binding is unconfirmed                                               |
| Context budget (window tokens, warn fraction, hard cap)              | ✏️           | Card should express three check states: ok / warn / refused                                                                                                                                                                         |
| Source: `builtin` / `user` / `plugin`                                | 🔒           |                                                                                                                                                                                                                                     |
| Duplicated-from                                                      | 🔒           | Set when the definition was duplicated from another                                                                                                                                                                                 |
| Folder                                                               | ✏️           | Palette organization                                                                                                                                                                                                                |
| Outputs: name + kind placeholders                                    | ✏️ pre-run   | Declared before any run exists                                                                                                                                                                                                      |
| Output state: published / bound / **broken**                         | ⚙️           | Published = placeholder made world-visible pre-run. Bound = a run produced it. Broken = producer deleted while still a placeholder — downstream stays visibly blocked, never silently unblocked. All three need distinct treatments |
| Wired inputs + their order                                           | ✏️           | Context order is operator-controlled                                                                                                                                                                                                |
| Run button + in-flight disable                                       | ⚙️           | Disabled while a run initiation is in flight (double-click cannot fire twice)                                                                                                                                                       |
| Cost estimate                                                        | ⚙️           | Always a basis + range + sentence, never a bare number; range is empty (not zero) when no prior run was priced                                                                                                                      |
| Workstream confinement                                               | 🔒           | A command never leaves its workstream                                                                                                                                                                                               |

---

## 3. Session node

The mirror image of a command: **nothing on it is an editable attribute.**
Everything is observed. The operator acts via gestures — inject, respond,
stop, fork, resume — not by editing fields.

| Attribute                                                         | Class | Notes                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase                                                             | ⚙️    | Ten states, each needs a visual: `thinking`, `responding`, `tool-running` (+ tool name), `compacting`, `waiting-approval`, `waiting-input`, `waiting-on-claim`, `stopped`, `failed`, `idle`. Phases are derived by PlotRoom from observations, never agent-reported                                               |
| Accounting: turns, tokens, cost USD (+ cost basis), last activity | ⚙️    | Live while running, not just at end                                                                                                                                                                                                                                                                               |
| Context-window meter (used/max, reported vs estimated)            | ⚙️    | Null until anything is known — design the empty state                                                                                                                                                                                                                                                             |
| End state                                                         | ⚙️    | **Six distinct outcomes that must look different:** `completed`, `ended-by-user` (names who), `stopped` (by user vs by session), `out-of-budget` (names which cap scope: run / workstream / global), `failed` (+ message), `interrupted` (crash/restart caught it in flight — not stopped, not failed, resumable) |
| Injection queue: queued vs delivered                              | ⚙️    | The two states are shown separately, by rule — `inject()` resolves on queue acceptance; delivery is a separate observed event                                                                                                                                                                                     |
| Open questions / approvals blocking it                            | ⚙️    | A question outlives the call it blocks; unpicked options remain visible                                                                                                                                                                                                                                           |
| Health alerts                                                     | ⚙️    | Derived from observation only, configurable thresholds (§7.2)                                                                                                                                                                                                                                                     |
| Runtime mode (native fork vs seeded)                              | 🔒    | Recorded at creation; says which fork branch actually ran                                                                                                                                                                                                                                                         |
| Position on canvas                                                | ✏️    | The only editable thing on the card                                                                                                                                                                                                                                                                               |

---

## 4. Workstream container

Two renderers by zoom level: **collapsed** (one card; edges from outside draw
to its frame) and **expanded** (a frame drawn behind its children).

| Attribute                                                                              | Class                 | Notes                                                                                          |
| -------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| Name                                                                                   | ✏️                    |                                                                                                |
| Status: `active` / `done` / `abandoned`                                                | ✏️ human-only gesture | A session can never set it — the refusal (`session_sets_lifecycle`) is itself a designed state |
| Subject (the ticket it was created from)                                               | 🔒                    |                                                                                                |
| Collapsed / expanded                                                                   | ✏️ view state         |                                                                                                |
| Activity rollup: producing commands done/total, sessions running/total, drifted inputs | ⚙️                    |                                                                                                |
| Attention rollup (counts by feed + overall status)                                     | ⚙️                    | Shown on the collapsed card                                                                    |
| Archived-at                                                                            | ⚙️ from gesture       |                                                                                                |

---

## 5. Shared overlays (every node)

All ⚙️ derived; none editable.

| Overlay                            | Notes                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attention badge (count + top feed) | One derivation, many surfaces (§7)                                                                                                                                        |
| Warning flags                      | Per-node messages, visible at **every** zoom level                                                                                                                        |
| Speech bubbles                     | Questions with clickable options; globally capped ("cap how many show at once", §5)                                                                                       |
| Two selection states               | **Route-selection** (the single node the address points at — drives navigation) vs **multi-select** (marquee). They currently share a border and need distinct treatments |
| Zoom-level renderers               | Three levels per node: workstream (identity only) → inner (adds id) → full detail. Node content switches by viewport zoom                                                 |
| Mid-drag edge refusal              | An illegal connection never _looks_ legal during the drag — refusal is a designed interaction, not an error after the fact                                                |

---

## Cross-cutting rules the designs must respect

1. **Refusals are identical everywhere** (principle 8): the canvas, the API,
   and agent tools refuse the same edge the same way — design refusal states,
   not error dialogs.
2. **Legal edges only** (§3.7): content → command and content → running
   session. Nothing else connects.
3. **Nothing is silently deleted**: released transcripts, broken placeholders,
   and compacted versions all leave a visible marker.
4. **Nodes are DOM-based** so plugin card renderers and keyboard accessibility
   (§11) work — no canvas-drawn cards.
5. **An arrangement at rest stays put**: rigid-body push during drag, no
   physics settling afterwards.
