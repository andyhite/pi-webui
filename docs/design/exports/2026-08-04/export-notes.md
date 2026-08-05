# PlotRoom project notes

**The design specification lives in `PlotRoom Design System.dc.html`.** It is the single source of truth: 18 sections covering colour, type, glass, atoms, the node grammar, chrome, panels, voice, a full node reference (every kind at every size), measured redlines, interaction, the keyboard map, the data model, layout and edge routing, zoom mechanics, window and accessibility, newly-designed states, the assembled canvas at two zoom levels, and a token table. Read it before changing anything.

- Committed visual direction: **Glass** on #101113 — Familjen Grotesk + JetBrains Mono, accent #f7a441, alert #e0655a. Origin: `PlotRoom Nodes.dc.html` §1b.
- **Icons: Lucide app-wide** (inline 24×24 stroke SVGs, stroke-width 2, currentColor). No hand-drawn CSS glyphs, no emoji.
- **Per-type colour:** content #6aaee0 · command #a893e8 · session #72c491 · workstream #c9a173. Tint carried in the glass gradient (rgba(hue,.14)→.05 at 158°), border rgba(hue,.32). Amber is reserved for attention, red for alerts — never a type tint.
- **Zoom ladder:** far <45% = 150×34 · mid 45–80% = 268w · full >80% = 340w, the only actionable level. Drop order outward: controls → bindings/history → title → type; the attention signal never drops.
- Earlier explorations, kept for provenance: `PlotRoom Smoke.dc.html` (the canvas screen), `PlotRoom Nodes.dc.html` (node design turns), plus the Glass / Hi-Fi / Chrome Wireframes files.
- Section 16 of the spec ("New states" — empty, loading, multi-select, drag, failure, overlays) is newly designed and has not been reviewed against the explorations. Treat it as a proposal.
