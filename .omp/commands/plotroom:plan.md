---
description: Turn a tracked item into an implementation plan before touching any code
---

Plan issue **#$1** before writing anything. Read-only: claim nothing, edit nothing.
The output is a plan I can disagree with while it is still cheap.

## Read, in this order

1. `issue://$1` — the item and its comments, which are where the real state is.
2. The spec section it claims (`docs/product-spec.md`). If it claims none, say so and
   name the section it should have claimed — an item with no spec section is either
   hygiene or under-specified, and those want different plans.
3. Its parent epic (`issue://<epic>`) — the epic's own body is its map now: what it
   owns, the order it takes its children in, and which other epic it must not walk
   into. An item with no parent and no `bug` label is itself a finding, not
   something to plan past.
4. `docs/development.md` — **which of the six shapes this change is**, and therefore
   the files in order, the example to copy, and the test the repo expects.
5. The architecture note for the area (`docs/architecture/`), and the code the change
   actually lands in. Use `scout` for a file map you do not have.

## Then say, concretely

- **The shape.** One of the six, or say why it is none of them.
- **The rule that governs it.** Which predicate in `@plotroom/core` already states it,
  or — if this change introduces one — where it goes and which surfaces must call it.
  A rule re-derived at a call site is the defect this repository cares most about.
- **The files, in the order you will touch them**, and for each: what changes and why.
  Name what you will **not** touch, especially anything another epic's active work owns.
- **The proof.** The exact test the shape requires, plus how you will exercise the
  change (`skill://plotroom-smoke`). If a change is only believable by clicking it,
  say what you will click and what you expect to see.
- **The schema question**, if any: does this touch the four §15 invariants, is a
  migration needed, does it need a reserved id?
- **What could make this wrong** — the assumption you are least sure of, and the
  cheapest thing that would confirm or kill it.
- **Anything the item asks for that should not be built**, or that is a decision rather
  than work: name it and say who owes the answer. An unasked question invented locally
  is worse than a blocked item.

Keep it short enough to argue with. No code, no branch, no board moves — `/plotroom:work`
does those, and it is the next step once we agree.

Extra arguments, if any, are constraints on this run: $@
