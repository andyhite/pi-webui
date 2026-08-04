# 0002 — UI styling and the design-system package

- **Status:** Accepted
- **Date:** 2026-08-04
- **Issues:** #53 (decision), #86 (the toolkit package)
- **Deciders:** operator

## Context

Nothing in the tree was styled: no authored CSS, no `className` attributes, no
CSS-in-JS — 20 inline `style={{…}}` props across four files, each annotated as
layout mechanics, under a standing design gate. The visual design is authored in
**Claude Design**, which exports self-contained HTML/CSS/JS, and the requirement is
that the export is a **reference to re-implement**, not an artifact to adopt.

Four properties of the codebase constrain the choice:

- **Plugins never supply markup.** A plugin's `CardView` is declarative title,
  lines and actions that the host draws, so style isolation — shadow DOM, runtime
  CSS-in-JS, iframes — is a non-requirement.
- **The theme contract is frozen and token-shaped.** The plugin SDK's
  `Theme { tokens: Record<string, string> }` exists with no consumer, awaiting
  this decision. It maps onto CSS custom properties and onto nothing else cleanly.
- **`packages/ui` builds with plain `tsc -b`** and has no bundler.
- **Node geometry is behavior.** The rigid-body push solver and the off-screen and
  bubble placement consume xyflow's _measured_ DOM sizes, so anything that changes
  a node's dimensions changes layout and the arrangement e2e gates.

## Decision

**Tailwind CSS v4, authored only inside `@plotroom/toolkit`**, with design tokens
as CSS custom properties.

1. **One token source, two outputs.** The token file is both Tailwind's `@theme`
   (custom properties, from which the utility scale derives) and the typed map that
   _is_ the SDK's `Theme.tokens`. A theme — the operator's or a plugin's — is a
   token override, never a stylesheet.
2. **Only the toolkit needs a build.** It emits ESM, types and one stylesheet;
   `packages/ui` keeps `tsc -b` and ships no CSS. Tailwind's `@source` covers
   the toolkit and `packages/ui/src`, so no second package needs a bundler.
3. **Components expose variants, never `className`.** A variant is a union type,
   so a caller cannot misspell a style, and consumers compose with layout
   primitives instead of authoring utilities. Visual decisions therefore cannot be
   made outside the toolkit.
4. **Node dimensions are tokens**, never content-derived, because the solver
   measures them. The arrangement e2e gates are re-baselined once, visibly, in the
   change that lands the styling.
5. **Escape-hatch CSS lives in the toolkit under `@layer`** for what utilities
   cannot express: xyflow overrides (`.react-flow__*` elements we do not render),
   keyframes, genuinely complex selectors.
6. **Each Claude Design export is checked in** under
   `docs/design/exports/<date>/` and the change that implements it names the
   export it worked from — the export is the reviewable input, not the source.

## Alternatives rejected

- **CSS Modules.** Its one real advantage is that a missing class is a build error.
  Against that: tokens end up stated twice (custom properties, then hand-written
  rules consuming them), a bundler is required in every package that authors
  styles, and dead rules accumulate with no purge and no warning.
- **vanilla-extract.** Typed tokens are excellent, but authoring styles in
  TypeScript makes reading a CSS design export a translation exercise again.
- **Any CSS-in-JS runtime.** Pays a runtime cost for isolation established above as
  unnecessary, on a canvas that re-renders at every zoom threshold.
- **Plain namespaced CSS.** The first proposal, made while the plan was to absorb
  the export's CSS. Once the export is re-implemented by intent, its advantage —
  diffability against the export — disappears.

## Consequences

The Tailwind gap — a misspelled utility is a silent no-op rather than a build error
— is covered three ways: variants are typed props, class ordering is deterministic
(`prettier-plugin-tailwindcss`), and the toolkit's gallery asserts every
primitive × variant × state with Playwright screenshots, which is what actually
catches a dropped style.

While the shell is Electron the renderer is Chromium only, so modern CSS
(`:has()`, container queries, subgrid) is fair game. If a system-webview shell is
adopted later, revisiting those is one auditable pass over the toolkit's
CSS rather than a permanent tax on every component.
