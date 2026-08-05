# PlotRoom — Product Voice

**Scope.** The canonical statement of how PlotRoom speaks — the words a surface may use for a state, the difference between what the product reports and what an agent claims, and what a string may never do (spec principles 3, 7, 11, 12; issue #250: "the interface reports; it does not encourage, apologise, or congratulate"). The state vocabularies themselves are defined in [session-lifecycle](session-lifecycle.md) and [run-lifecycle](run-lifecycle.md); this doc governs their rendering as copy.

---

## 0. Why this exists

Every governing principle in `docs/product-spec.md` §2 is a claim about what PlotRoom is honest about — completion is proven, not claimed (principle 3); the product derives from observation, never from inference (principle 7); failure is bounded and reported, distinguishing _it did not work_ from _it was stopped_ from _it ran out of budget_ (principle 11); nothing is silently truncated (principle 12). Voice is where those principles reach the screen. A string that says "success!" where nothing was proven, or "something went wrong" where a reason was known, is not a tone problem — it is the product lying about what it just told the truth about internally. §250 names this directly: voice is "the cheapest section to ignore and the most visible when it drifts, because every surface writes strings."

This document states the rules already load-bearing in the tree — the state names in `packages/core/src/runs.ts` and `packages/core/src/sessions/end-states.ts`, the refusal shapes in `packages/core/src/edges.ts` and `packages/core/src/claims/`, the typographic split already shipped in `packages/toolkit/src/tokens.ts` — plus what #250 adds on top that nothing has implemented yet. Where the two disagree, the rule cites which one it comes from. Where #250 leaves something genuinely unresolved, §6 says so instead of inventing an answer.

---

## 1. The state vocabulary

A state is a single lowercase word or a hyphenated pair, never a sentence and never Title Case. Every state word means exactly one thing in the product; a word is never reused across two mechanisms that mean something different, even when the familiar one is the tempting choice.

### 1.1 Session and run outcomes

`packages/core/src/runs.ts` (`RUN_STATUSES`) and `packages/core/src/sessions/end-states.ts` (`SESSION_END_KINDS`) hold one taxonomy, deliberately kept in sync:

| Word                              | Means                                                                                                           | Never means                                                                                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `completed`                       | A producing session's outcome was proven against the world (principle 3).                                       | Never "the agent said it was done" — that is not observable, so it cannot be this word.                                                             |
| `stopped`                         | A human or a session stopped it on purpose (§6.7).                                                              | Never a crash, and never out-of-budget — "stopped means stopped" (`docs/product-spec.md` §4.1).                                                     |
| `failed`                          | Unrecoverable failure, with the reason the type requires (`{ kind: "failed", message: string }`).               | Never out-of-budget, never interrupted — conflating any of the three "makes every cross-run outcome dishonest" (`packages/core/src/runs.ts:81-83`). |
| `out-of-budget` / `out_of_budget` | The money ran out; PlotRoom stopped the work deliberately. Its own outcome, not a flavor of failure (§3.6, §8). | Never "failed" — a retry "must not blindly re-run" it (`packages/core/src/budgets.ts:305`), which a failure label would invite.                     |
| `interrupted`                     | A crash or restart caught the session in flight; nobody decided anything (principle 11).                        | Never "stopped" (somebody chose that) and never "failed" (the work didn't fail, nobody knows yet).                                                  |

`describeEnd()` (`packages/core/src/sessions/end-states.ts:181-199`) is the one place these render as sentences — `"stopped by you"`, `"out of budget (workstream)"`, `"failed: the build broke"` — so no surface invents its own wording for "the money ran out."

**Done is suggested, never declared.** A workstream's lifecycle is `active`, `done`, or `abandoned` (`packages/core/src/workstreams.ts`), and the human sets it. `suggestDone()` (`packages/core/src/workstreams.ts:143`) computes a recommendation — every producing command completed, or every session ended with nothing drifted — but nothing calls it to transition a workstream automatically: "a suggestion is a proposal the human confirms; nothing calls this to transition automatically, ever" (`packages/core/src/workstreams.ts:140-141`). `done` names only this one lifecycle state; it is not reused as a synonym for a run's `completed` or a session's `ended-by-user`.

### 1.2 Delivery: queued, delivered, refused

An injection's delivery status is exactly one of `"queued" | "delivered" | "refused"` (`packages/ui/src/bubbles/model.ts:25`, `InjectionBubbleStatus`), rendered distinctly on its bubble because "queued vs delivered renders distinctly (§6.5)" (same file, line 53). The same three words describe a run admitted under the concurrency limit: `docs/product-spec.md` §4.1 — "a queued run is visible as queued, shows its position, and can be cancelled before it starts." Both uses share one meaning — _accepted, not yet in effect_ — so this is consistent vocabulary, not a collision to flag.

### 1.3 Workspace readiness

`READINESS_STATES` (`packages/core/src/workspaces/readiness.ts:18-30`): `unprovisioned`, `provisioning`, `setup-required`, `setup-running`, `ready`, `setup-failed`, `provision-failed`. `checkReady()` is the one gate; "nothing may run in a workspace that is not ready" (same file, line 217), and not-ready always renders with the reason visible (`"Workspace is not ready: {label} has not run yet."`, line 245) — never a bare disabled control.

### 1.4 Drift

`drift` names exactly one thing: content that changed after work consumed it (`docs/product-spec.md` §3.2 — "drift is a state, never an action"). Workspace-level change from an external cause (a rebase, a hand edit, a cross-merge) is a different word, **divergence** (§3.4, §4.3) — kept distinct even though both describe "the world moved," because they trigger different responses: drift flags a consumer for a human decision, divergence forces a fresh session outright. The vocabulary keeps them apart on purpose.

### 1.5 The rule, stated once

A state word is never reused to mean something else. Where the same English word plausibly applies to two mechanisms, the tree either uses it for one and picks a different word for the other (`drift` vs `divergence`), or confirms the two uses share the same underlying meaning (`queued` for a run and `queued` for an injection). One place states each vocabulary — `RUN_STATUSES`, `SESSION_END_KINDS`, `READINESS_STATES`, `InjectionBubbleStatus`, `TriageVerb` — and a surface renders from that type, never a string literal it invented locally.

---

## 2. The machine/human split

### 2.1 Typography is already the enforcement mechanism

#250: "anything the machine reports is mono and lowercase, anything a human wrote is sans and sentence case. Numbers are always mono, with no exceptions." This is not aspirational — it is shipped: `packages/toolkit/src/tokens.ts` defines `--pr-font-mono` for "ids, labels, states, every number. ... Numbers are always mono, with no exceptions" (lines 422-429) and `--pr-font-sans` for prose, with `--pr-type-panel` called out as "the one place a heading is not mono" (line 481) and `--pr-type-node-id` for "a workstream's identity" (line 490). `Input.tsx` and `Select.tsx` set `--pr-type-mono` on typed values because "typed values are data, not prose" (`packages/toolkit/src/primitives/Input.tsx:43-45`). The split is real, tested (`packages/toolkit/src/theme.css.test.ts`), and it is the mechanical enforcement of this section's rule: **if it's a fact PlotRoom observed, it renders mono; if it's prose a human or the model authored, it renders sans.**

### 2.2 What the product states as fact vs. what it attributes to a claim

Principle 3 ("completion is proven, not claimed") and principle 7 ("derive from observation, never from inference — if it cannot observe something exactly, it does not claim it") are the split's substance, not just its typeface. Phases are "derived continuously," and derive from "events the runtime emits about itself — that is _observation_ of the runtime. What stays untrusted is an agent's claims about the world: those are proven, never believed" (`docs/product-spec.md` §3.6, echoed verbatim in `packages/core/src/sessions/phases.ts:12-21`). Concretely:

- **Observation-derived copy speaks plainly, as fact.** A session's phase (`thinking`, `tool-running`, `waiting-on-claim`, …) is stated without hedging, because it came from the runtime's own account of itself (`packages/core/src/sessions/phases.ts`). A health alert like _idle_ or _spinning_ is "derived from observation, never reported by the agent" (`docs/product-spec.md` §7.2) and is stated the same way.
- **An agent's claim is marked as a claim.** The plan — "the runtime's continuous account of what the session thinks it is doing" — is "read and rendered, never acted on ... and it proves nothing: completion stays with the world" (`docs/product-spec.md` §3.6). The health alert built from it is literally named for this: **"Blocked, by the session's own account"** (§7.2) — the alert exists because a session's plan said so, and the name says whose word it is on. A submitted outcome is never rendered as done; it is "rejected, with the failing condition returned as feedback" until the world's own predicates hold (§3.5). Nowhere does the product render an agent's self-report as if it were an observed fact.

### 2.3 Refusals name the rule and the way forward

Every refusal in the tree is a structured `{ reason, message }` (`ConnectionRefusal`, `PublishRefusal`, `ClaimRefusal`, `ReadinessRefusal`, …) — never a bare "no." The `message` states what rule blocked the gesture and what to do instead, in place, never as a dialog (#250: "Refusals name the rule, state what was attempted, and say what happened instead — in place, as a line in the node, never as a dialog"). Three real examples:

> "granting this would deadlock: {loop}. {yours}."
> — `packages/core/src/claims/deadlock.ts:235`, generated by `describeDeadlock`; the actual rendered form names the paths in the cycle and which one you hold, so the way forward — yield one of those — is inferable from the sentence itself, matching the exemplar in the type's own doc comment: _"granting this would deadlock; you hold `src/api/`"_ (`packages/core/src/claims/deadlock.ts:18-20`).

> "that session has ended; fork or re-run it instead"
> — `packages/core/src/edges.ts:142`, refusing a context edge into a session that isn't running. Names the rule (a dead session can't receive context) and both ways forward in the same sentence.

> "assembled content is 12,000 tokens, over this command's hard cap of 8,000; remove inputs rather than truncating"
> — `packages/core/src/commands.ts:273` (`checkContentBudget`). Names the rule (the hard cap), the numbers that triggered it, and explicitly rules out the wrong fix (truncating) in favor of the right one.

A fourth, for the same-shape rule applied to a different gesture: "this output already produced an object; promote the object instead of publishing the placeholder" (`packages/core/src/commands.ts:410`, `checkPublish`) — states which of the two verbs (publish vs. promote, §3.5) applies now that state has moved on.

Principle 8 makes this uniform by construction: "a refusal is identical whichever surface asked" — one gate, one message, whether the UI or an agent tool triggered it. Guidance sent to an agent (`BUDGET_GUIDANCE`, `packages/core/src/budgets.ts:206-209`) follows the same discipline even though no human ever reads it rendered: it states the rule ("do not race the budget — skipping verification to fit under it is a failure mode, not a saving"), never dresses it as encouragement.

---

## 3. Numbers and honesty

**Estimates state their basis and render as ranges.** `estimateRunCost()` (`packages/core/src/runs.ts:298-335`) has exactly two outcomes, and no third: `"$0.01–$0.03 based on 3 prior runs of this definition"` when priced history exists, or `"no priced history for this definition; input size only (about 4,000 tokens in)"` when it doesn't (`packages/core/src/runs.test.ts:60-94`; the type comment at `packages/core/src/runs.ts:237-246` states the design outright: _"a bare number invites the reader to treat a guess as a quote, so this type cannot express one."_). A run whose runtime reported no cost is excluded from the average rather than counted as free (`packages/core/src/runs.ts:293-296` — "averaging a zero into the range would quietly halve the estimate"). The same discipline holds for context-window occupancy: `basis: "reported" | "estimated"` is carried on the number itself (`packages/core/src/sessions/accounting.ts:47-49`), so a surface can say which kind of number it's showing.

**Counts are exact.** Spend, tokens, turns, and elapsed time are recorded and displayed as what the provider or runtime actually reported (`docs/product-spec.md` §8 — "cost is what the provider said it was ... never re-derived from a price sheet"). Nowhere does the tree round a count for presentation; `formatMicros()` (`packages/core/src/runs.ts:342`) is the one place currency renders, precisely so two screens can't disagree about the same run.

**Truncation is always marked.** Principle 12 — "never silently truncate content ... the product warns, or caps by explicit choice, and never quietly drops" — is enforced structurally, not just by convention: `checkContentBudget()`'s result type has no "truncate to N" variant at all, only `ok | warn | refused` (`packages/core/src/commands.ts:241-252`; the test names this directly, "there is no third answer: the result carries no truncation instruction," `packages/core/src/commands.test.ts:142-143`). A transcript that releases old tool output leaves a visible marker (`ReleaseMarker`, `packages/core/src/sessions/transcript.ts:16-24`) and can reload it; an export of a released transcript reports `complete: false` and lists what it couldn't recover rather than shipping a silent hole (`packages/core/src/sessions/transcript.test.ts:166-174`). A search result that hit its limit reports `truncated` and the limit alongside the hits, not just the hits (`packages/ui/src/search/SearchPanel.tsx:111`). An outbound notification's summary is hard-capped at 300 characters and the function that enforces it is named for the principle it serves (`ROUTED_SUMMARY_MAX_CHARS`, `packages/core/src/attention/routing.ts:124-127`).

---

## 4. What is never said

| Never                                                                                           | Why (principle or observed pattern)                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropomorphizing beyond attribution — "PlotRoom thinks," "the agent wants," "it's trying to." | The product attributes speech and gestures to their sender (§5, "attribution is the point") but never invents an interior state for something it only observes phases and events from (principle 7). A phase name is a fact about the runtime, not a mood.                                                                                      |
| Success theater — "Great! All done!", exclamation marks, celebratory copy.                      | "The interface reports; it does not encourage, apologise, or congratulate" (#250). Completion renders as the fact `completed` (mono, plain), never dressed up — because dressing up a proven fact and dressing up an unproven one would read identically, which is exactly what principle 3 forbids conflating.                                 |
| Blame-the-user — "you forgot to...", "your input was invalid" as a rebuke.                      | Refusals name the rule and the way forward (§2.3 above), never the caller's failing. `"that session has ended; fork or re-run it instead"` states a fact and a fix, not a correction of the user.                                                                                                                                               |
| A silent "something went wrong" with no reason.                                                 | Principle 11: "a thing that gave up says why." `readinessProvisionFailed` records the honest reason verbatim (`packages/core/src/workspaces/readiness.ts:116`); a failed session's end state is typed to require a `message` (`packages/core/src/sessions/end-states.ts:56`) — there is no failure variant that can be constructed without one. |
| A timer dressed as a question — a default that "just proceeds" if you don't answer in time.     | Principle 2, made explicit for questions in §6.4: "no question may carry a default that proceeds on a timeout." A structured question's answer "returns to the session as a result," and there is no path where silence is read as an answer.                                                                                                   |
| Guessing at what an external process is doing and stating it as fact.                           | Principle 7, verbatim: "if it cannot observe something exactly, it does not claim it." A broken integration connection is reported as a connection problem, never inferred as "no data" (§9.3).                                                                                                                                                 |
| Degrading a concept's absence into a half-working state.                                        | §3.1: "concepts are present or absent, never degraded. There is no 'this ticket source is unavailable' state in the core model." If no integration produces tickets, there are no tickets — no surface renders apology copy for a missing connector.                                                                                            |

---

## 5. Attribution

**Speech bubbles name their sender.** `BubbleSource` (`packages/ui/src/bubbles/model.ts:26-55`) is documented against §5 and §6.5 directly: "a message draws as a bubble on the node that produced it — a command shows the prompt it dispatched, a session shows what it is saying, a tool in flight shows as a distinct chip. Attribution is the point" (lines 3-7). Every bubble carries a `nodeId` and a `kind` (`command-prompt | session-output | tool-in-flight | question | injection`) — there is no anonymous bubble.

**Queue rows name their sender the same way.** The attention queue (§7.1) is fed by unanswered questions, approvals, drift, health alerts, completions, and session-originated broadcasts — every `AttentionItem` (`packages/ui/src/attention/types.ts`) carries what raised it and, for a broadcast, who sent it (§6.5: "an agent telling twelve other agents something is exactly the class of event worth knowing happened" — the operator sees it precisely because it names the sender).

**The operator's triage verbs, and their precise meanings** (§4.5, §7.1; implemented identically for every feed via one `TriageLedger` — `packages/ui/src/attention/queue.ts:2-9`, "every feed supports the same three triage verbs ... which is why they share one ledger rather than six bespoke ones"):

- **acknowledge** — "seen; the consumer's baseline advances without running anything" (`docs/product-spec.md` §4.5). It is not "resolved" and it is not "approved" — a drift flag's acknowledgement moves the baseline forward with no side effect on the world, "a typo fix on a ticket shouldn't cost eight decisions." Answering a question or deciding an approval _is_ an acknowledge under the hood (`acknowledgeOnAnswer`, `packages/ui/src/attention/queue.ts:110-116`) — the row leaving the queue is the confirmation the answer registered, never a separate step.
- **snooze** — "bring it back later" (`packages/ui/src/attention/types.ts:216`). `snoozeUntil` is set, and the item is hidden only until that time passes, at which point it returns as if newly raised — "a snooze that elapses is, correctly, a new arrival to be noticed again" (`packages/ui/src/attention/notifications.ts:13-16`).
- **mute** — "never show this one again" (`packages/ui/src/attention/types.ts:218`). Permanent, unlike snooze; a muted item does not return.
- **pin** — a different verb, over run history rather than the queue (§4.4): "pinning is the human's word for _never compact this_" (`docs/product-spec.md` §4.4, echoed at `packages/core/src/runs.ts:123`). A pinned run and everything it references is retained forever; nothing else about it changes. Kept distinct from acknowledge/snooze/mute because it answers a different question — not "have I seen this" but "may this ever be deleted."

---

## 6. Open questions

Per #250's own framing, the following are genuinely unsettled rather than settled facts this document could state as rules:

1. **Whether "4 need you"-style cost-framed counts are a committed rule or a proposal.** #250 says "counts are phrased in what they cost you: '4 need you', not '4 items require attention.'" Nothing in the tree today renders a count this way — the queue and fleet views report counts and totals (`docs/product-spec.md` §7.1, §8) without a settled phrasing convention for the aggregate case. This document does not invent one; whichever surface implements it first should record the exact phrasing here.
2. **Whether refusal/guidance text delivered to an agent (never rendered to a human) is bound by the "never" list in §4 the same way UI copy is.** Principle 8's "a refusal is identical whichever surface asked" resolves the _refusal_ case — `BUDGET_GUIDANCE` and the claim-manager's refusal messages already read as plain, undecorated fact either way. What's unresolved is whether that guarantee is a hard invariant with a test behind it anywhere, or an emergent property of refusals being defined once and consumed by both surfaces. No test in the tree currently asserts "an agent-facing message and a human-facing message for the same refusal are the same string" as its own proposition.
3. **Whether a lint or equivalent check enforcing this vocabulary exists yet.** #250's acceptance criteria ask for "a surface cannot render a state outside [the vocabulary]" and "no emoji, exclamation mark or encouragement string exists in the rendered product — checked, not asserted." This document records the vocabulary as it exists in the type system (`RUN_STATUSES`, `SESSION_END_KINDS`, `READINESS_STATES`, `InjectionBubbleStatus`) and audited a representative sample of `packages/ui/src`, `apps/web/src`, `packages/core/src`, and `apps/server/src`, finding no violations of §4's list — but a full audit with an enforcing check is #250's stated target, not this document's, and is not claimed as done here.
