---
description: docs/product-spec.md is the behavioral truth — amending it is an operator decision, never a side effect of shipping something else
condition:
  - "**/product-spec.md"
interruptMode: tool-only
---

You are editing **the spec every other document and the product itself are
corrected against**. Before you write:

- **Which direction is the correction?** The spec disagreeing with the tree
  normally means the tree is wrong. Changing the spec so the code stops
  violating it is backwards — fix the code, or say plainly that you're
  proposing an amendment.
- **An amendment needs the operator.** A change to a governing principle is a
  change to the product thesis: raise it, get an explicit decision, and record
  it in the issue. It is never a paragraph slipped into a feature PR.
- **A recording edit is fine** — the spec already described this behavior and
  you're correcting a typo, a stale reference, or a contradiction between two
  of its own sections. Say which in the commit message.

The same weight applies to the docs beneath it (`docs/data-model.md`,
`docs/enforcement.md`, the lifecycle docs) when the edit changes a contract
rather than describing one.
