---
name: plotroom-canvas
description: How PlotRoom's canvas is built on top of xyflow — rigid-body push, collapsing containers, zoom-level semantics, mid-drag refusal, and why nodes stay DOM-based (which is what makes keyboard reach and the a11y e2e suite possible). Read before editing canvas code in packages/ui or a test that reaches canvas nodes through the DOM.
---

# The canvas

xyflow is the base. The spec's harder canvas requirements are built **on top of**
it, not by forking it:

- **Rigid-body push** — custom drag handling (`onNodeDrag`) plus a collision/push solver over node extents. No physics simulation; an arrangement at rest stays put.
- **Collapsing containers** — xyflow parent/child nodes; a collapsed workstream is one node and edges draw to its frame.
- **Zoom-level semantics** — read the viewport zoom and switch node renderers by level (workstream card → inner nodes → full detail).
- **Mid-drag refusal** — `isValidConnection` / connection-state hooks, so an illegal edge never looks legal.
- Nodes stay DOM-based so plugin card renderers and keyboard accessibility (spec §11) work.
