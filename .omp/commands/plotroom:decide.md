---
description: Record a decision as an ADR in the house style, or say why it is not one
---

The decision: $@

`docs/decisions/README.md` in `~/plotroom` is the house style — read it first; it has
the numbering, the metadata block, the `Status` vocabulary, the spine, and the amendment
and superseding rules.

## 1. First ask whether this belongs here at all

A decision is recorded **where work is tracked** by default. It becomes a record only
when the _reasoning_ has to survive: a stack or boundary choice, a schema shape plus the
product rules the schema cannot state, or a measurement that gates a deferred decision.

The other homes, so a record is not the reflex:

- **A rule an agent must follow** → `AGENTS.md`.
- **Why a subsystem is shaped as it is** → `docs/architecture/`.
- **Local to one file** — why this function refuses in this order → a docblock beside
  the code, with the issue number that authorised it.
- **Everything else** → a comment on the tracker item.

Say which one you picked and why. If it is not an ADR, do that instead and stop.

## 2. If it is a record

**Claim the number on the tracker before writing** — several lanes write records and two
`0007`s cannot both land. Then write it: `docs/decisions/NNNN-kebab-slug.md`, the
metadata block, `Context → Decision → Consequences`, and `Alternatives rejected` naming
each loser with the single thing it was better at.

Two things the existing records do that are worth copying:

- **A deferral is recorded as a deferral, with its trigger named.** "Deferred until the
  shell decision lands" is a decision; silence is not.
- **`Consequences` states what the decision obliges, including work that does not exist
  yet.** A record whose implementation is unwritten still constrains it.

If the decision is mine to make rather than yours, write it with
`Status: Proposed` naming exactly what is unanswered, and **ask me** — do not accept it
on my behalf. `Deciders` is `operator` unless the record decides nothing.

## 3. Land it

One record, one `docs:` commit, subject `record <the thing>`, body two or three
paragraphs of the argument. It rides with nothing else, and nothing else rides with it.
Then `/plotroom:land <n>` — a record goes through a pull request like everything else.

If this decision contradicts something already in `docs/`, **do not fix that here**:
record the contradiction on the tracker and let it be its own change.

## 4. Report

The path, the number, the `Status`, the issues it names, and — if you wrote `Proposed` —
the question I owe an answer to.
