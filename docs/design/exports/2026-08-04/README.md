# Claude Design export — 2026-08-04

The design system for PlotRoom's interface, exported from Claude Design. Per
decision 0002 §6 this export is **the reviewable input, never the source**: it is
re-implemented as idiomatic application code in `@plotroom/toolkit`, and the
change that implements against it names this directory.

Open `PlotRoom Design System.dc.html` in a browser (it loads `support.js` from
beside it and two Google-hosted faces from the network). Eighteen sections: the
language (§01–07), the node reference and measured redlines (§08–09), behaviour
(§10–15), newly-designed states (§16), the assembled canvas (§17), and the token
table (§18).

**§18 is the contract this repository implements.** It names every value in the
document — `--pr-canvas`, `--pr-content`, `--pr-node-full-w`, `--pr-glass`, and
the rest — and asks the implementation to use those names so the code and the
spec share one vocabulary. `packages/toolkit/src/tokens.ts` is that table,
transcribed once.

Two of the document's own rules bear repeating here, because they are easy to
lose in a diff:

- **Every number is exact**, measured at 1440 × 900. The odd values (9, 11,
  12.5, 158°) are deliberate and must not be rounded.
- **§16 is a proposal.** Those six cards (empty, loading, multi-select, drag,
  failure, overlays) were designed for this document and have not been reviewed
  against the earlier explorations. Everything in §01–§15 and §17–§18 derives
  from decisions already committed.

## What is here, and what is not

| File                             | What it is                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `PlotRoom Design System.dc.html` | the export, byte-for-byte                                                          |
| `support.js`                     | the export's own runtime, byte-for-byte                                            |
| `export-notes.md`                | the operator's notes shipped beside the export, renamed from the export's own file |

The rename is the one edit made to the export: its notes arrived as `CLAUDE.md`,
a filename several agent harnesses load as directory context, and a design note
is not a standing convention for this repository (AGENTS.md is). The content is
untouched.

The export's thumbnail image is deliberately not committed — a preview is not a
reviewable input. The earlier explorations it cites for provenance
(`PlotRoom Smoke`, `PlotRoom Nodes`, the Glass / Hi-Fi / Chrome wireframes) are
not committed either; this document supersedes them and says where it came from.

The three files above are `.prettierignore`d for the same reason
`docs/product-spec.md` is: a formatter pass would make the export no longer the
export. This README is ours, so it is formatted and checked like any other prose.
