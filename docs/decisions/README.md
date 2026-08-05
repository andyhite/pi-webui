# Decision records — the house style

How to write a record in this directory: what the seven existing records have in
common, stated so the eighth does not have to infer it. Where they disagree, this file
picks one and says which record it is departing from — `0000` is an archive and `0001`
predates the convention, so neither is a model.

A decision is recorded **where work is tracked** by default. It becomes a record here
when it deserves prose: a stack or toolchain choice, a boundary or vendor choice, a
schema shape plus the product rules the schema cannot state, or a measurement that
gates a deferred decision. What all four have in common is that the _reasoning_ has to
survive — a tracker comment says what was decided, a record says why the alternatives
lost. Everything else stays on the tracker, and `AGENTS.md` takes only the standing
conventions an agent must follow.

## Claiming a number

`NNNN-kebab-slug.md`, four digits, allocated in order of landing. `0000` is the archive
of decisions that predate this directory.

**Claim the number on the tracker before you write**, the same way migration ids are
claimed: several lanes write records, and two records numbered `0007` cannot both land.
If you find your number taken when you rebase, renumber yours — the file has no readers
yet, and a record already on `main` has.

The slug names the subject, never the issue: `versioning-and-release`,
`collection-membership`. The H1 repeats the number with an em dash.

## The shape

```md
# 0007 — What was decided

- **Status:** Accepted
- **Date:** 2026-08-04
- **Issues:** #123 (decision), #124 (implementation)
- **Deciders:** operator

## Context

What forced a decision. The constraint, the spec section it lives under, and what
made the status quo untenable. Cite sections and principles by number (`§6.6`,
`principle 1`) rather than quoting them.

## Decision

Numbered items, each opening with a **bold one-line claim** and then the reason.

## Alternatives rejected

Each named with the single thing it was better at — "it needed no migration, and that
was its only advantage."

## Consequences

What this obliges someone to do, including work that does not exist yet. State the
constraint the future implementation has to meet.
```

`Context → Decision → Consequences` is the spine — `0002`, `0003` and `0005` follow it,
`0004` drops `Consequences` for a `Prerequisite`. `Alternatives rejected` is optional
and only `0002` has one, which is a shame: it is usually the section a later reader
needs. A record may add its own headings when
its job is different — an evaluation of candidates, or a spike's measurement — but it
still opens with the metadata block.

**`Status`** is one of: `Accepted`, `Accepted, with one part deferred`,
`Accepted (spike result)`, `Proposed` (a record committed before the operator has
answered — say what is unanswered in the line itself), `Superseded by NNNN`, or
`Archive`. `Proposed` and `Superseded by NNNN` have no instance yet; the rest are in
use. Anything else is prose nobody can search for — `0001`'s head `Status` carries a
whole amendment inline, which is the thing this list exists to stop.

**`Issues`** is `#N (role)` per role — which item authorised the decision, which will
implement it, which defect prompted it. It is the only link between a record and the
tracker, so a record with no `Issues` line is unfindable from the work that produced
it. (`0000` and `0001` have none, and `0001` carries an `Epic:` field instead: both
predate the tracker this repository uses now.)

**`Deciders`** is `operator` in most cases (`0001` splits proposal from acceptance). A
record that decides nothing says so: `none — this records a measurement, not a choice`.

## Deferring, amending, superseding

**A deferral is recorded as a deferral, with its trigger named.** "Deferred until the
shell decision lands" is a decision; silence is not. The trigger is what a later reader
tests to know whether the deferral still holds.

**An amendment is appended, never a rewrite.** Add a final
`## Amendment — <date>: <what changed>` section with its own metadata block whose
`Status` names what it overrides. Leave the original prose exactly as written —
superseded reasoning is the record's most valuable part, because it says what was
believed and why that turned out to be wrong. The section is the mechanism: do not put
the amendment in the head `Status` line as well. `0001` does both, and that is the
example not to follow — its adapter-order amendment is only findable by reading the
`Status` line, while its `omp` amendment is a section anyone can find.

An amendment may supersede part of a record (`0001`'s does). Reach for a **new record**
instead when the whole subject is being re-decided rather than one item refined.

**A new record supersedes an old one** when the subject is being re-decided rather than
refined. The new record's `Status` names what it supersedes, and the old record's
`Status` becomes `Superseded by NNNN` — both directions, because a reader arriving at
the old one has no other way to know.

**A record that answers an earlier record's gate** is a new record, not an amendment,
and it says so: it closes the gate and leaves the deferred decision deferred unless it
was itself the decision.

## Committing one

One record, one `docs:` commit, subject `record <the thing>`:

```
docs: record the versioning and release decision
```

The body is two or three paragraphs of _why_ — the same argument compressed, so a
`git log` reader gets the point without opening the file. Corrections to a record use a
verb that says what changed (`docs: stop calling the styling approach an open
decision`), never `update` or `fix docs`.

A record never rides along with an implementation, and an implementation never carries
the record's edit (`AGENTS.md` → "Documentation").

## Where decision prose also lives, legitimately

A rule that an agent must follow goes in `AGENTS.md`. Why a subsystem is shaped as it
is goes in `docs/architecture/`. And a **local** decision — why this function refuses
in this order, why this column exists — belongs in a docblock beside the code, with the
issue number that authorised it, because that is where the next person to change it
will be looking. Use the docblock for what is local to one file, and a record for
anything a second file would have to agree with.
