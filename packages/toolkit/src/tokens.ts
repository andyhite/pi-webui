/**
 * The design tokens, transcribed from §18 of the Claude Design export in
 * `docs/design/exports/2026-08-04/`.
 *
 * §18 is titled "Every value in this document, named" and asks the
 * implementation to use its names "so the code and the spec share a
 * vocabulary". This file is that table and nothing else: it holds no opinion
 * about how a token is used, and every value here can be read back in the
 * export. Two of the document's own rules constrain edits:
 *
 * - **Every number is exact**, measured at 1440 × 900. The odd values (9, 11,
 *   12.5, 158°) are deliberate; rounding one is a design change.
 * - **Dark only.** No value here has a light-mode counterpart, so there is no
 *   second table and no theme switch. A theme override is a token override
 *   (decision 0002) — that is what `--pr-*` custom properties are for.
 *
 * One source, two outputs (decision 0002 §1): `theme.css.ts` renders this array
 * into `theme.generated.css` — a `:root` block of `--pr-*` properties plus an
 * `@theme inline` block that maps Tailwind's namespaces onto them — and
 * `theme.ts` renders the same array into the plugin SDK's frozen `Theme.tokens`.
 * Neither output restates a value, so they cannot disagree.
 *
 * Provenance is comments rather than a `note` field on purpose: nothing reads it
 * at runtime, and as data it shipped 16KB of prose to the browser.
 *
 * ## Where this extends §18, and why
 *
 * §18 is a table for humans, so a few of its rows name one token and state two
 * values, and a few state a value inline without naming it. Those are the only
 * places this file adds a name, and each one says so. The rule for adding one: a
 * value the implementation must reference needs a name, and the name follows
 * §18's own convention.
 *
 * - `--pr-hue` — the recipes in §18 are written `rgba(hue, .14)`. `hue` is the
 *   node's family triple, which is what the `-rgb` tokens exist for, so the
 *   recipes reference `var(--pr-hue)` and a node sets it once. This is the
 *   mechanism behind §01's "one value decides a node's whole colour story".
 * - The second value of `--pr-footer-h` (32, the frame strip), `--pr-rail-w`
 *   (28, its buttons) and `--pr-control-h` (30, floating) each get a suffixed
 *   name, because a custom property holds one value.
 * - `--pr-divider` and `--pr-focus-ring` are two declarations each in §18 (a
 *   border plus a shadow; an outline plus an offset), so each is two tokens.
 * - `--pr-selection-rgb` follows the convention §18 uses for the family hues,
 *   so the selection halo can reference the colour it is made of instead of
 *   restating its triple.
 * - Four values §18 or §09 states inside a sentence rather than as a row get a
 *   name, because otherwise the first component to need one hardcodes it and the
 *   design's own rule stops being reachable: the attention/alert border weight
 *   (`--pr-glass-border-signal`, .45), the frame's (`--pr-glass-border-frame`,
 *   .28), the recessed footer background (`--pr-body-footer`), and the
 *   wordmark's letter-spacing (`--pr-ls-brand`).
 * - The `geometry` group is the measured node and frame anatomy — §18's sizes
 *   plus §09's redlines and §13's placement numbers. It is one group because
 *   those numbers are **behaviour**: the rigid-body push solver and the
 *   off-screen and bubble placement consume xyflow's *measured* DOM sizes
 *   (decision 0002 §4), so a padding that changes a node's height changes layout
 *   and the arrangement e2e gates. A component may not hold them.
 */

/** Which part of the design system a token comes from. */
export type TokenGroup =
  /** §18 COLOUR. */
  | "colour"
  /** §18 TYPE. */
  | "type"
  /** §18 MOTION. */
  | "motion"
  /** §18 SPACE, RADIUS, SIZE. */
  | "size"
  /** §18 sizes plus §09's redlines — measured anatomy the solver consumes. */
  | "geometry"
  /** §18 SURFACE RECIPES. */
  | "surface";

/**
 * One named value.
 *
 * `name` is the `--pr-*` custom property §18 asks for and is also the key in
 * `Theme.tokens`; `theme` is the Tailwind v4 theme key that resolves to it,
 * present only where a utility earns its keep (see `theme.css.ts`).
 */
export interface DesignToken {
  readonly name: `--pr-${string}`;
  readonly value: string;
  readonly group: TokenGroup;
  readonly theme?: `--${string}`;
}

/**
 * §18, in the export's order rather than alphabetically — reviewing a token
 * change means reading the two side by side.
 */
export const DESIGN_TOKENS: readonly DesignToken[] = [
  /* ------------------------------------------------------------------ colour */

  // §01: the canvas is never flat. Three grey radial washes lift the middle, a
  // corner vignette closes it, and the dot grid sits over the top — glass needs
  // something to refract, and a flat fill kills the surface language.
  {
    name: "--pr-canvas",
    value: "#101113",
    group: "colour",
    theme: "--color-canvas",
  },
  // Drawn at the `--pr-grid` pitch. §13: the dots are the snap targets, not
  // decoration.
  {
    name: "--pr-canvas-grid",
    value: "rgba(220,228,238,.045)",
    group: "colour",
    theme: "--color-canvas-grid",
  },

  {
    name: "--pr-body-node",
    value: "rgba(22,24,27,.55)",
    group: "colour",
    theme: "--color-body-node",
  },
  {
    name: "--pr-body-panel",
    value: "rgba(18,19,22,.62)",
    group: "colour",
    theme: "--color-body-panel",
  },
  {
    name: "--pr-body-chrome",
    value: "rgba(16,17,19,.68)",
    group: "colour",
    theme: "--color-body-chrome",
  },
  {
    name: "--pr-body-frame",
    value: "rgba(18,20,23,.40)",
    group: "colour",
    theme: "--color-body-frame",
  },
  // §01 DEPTH: inputs invert the stack — darker than their container, so typing
  // feels like it happens inside the glass.
  {
    name: "--pr-body-well",
    value: "rgba(0,0,0,.30)",
    group: "colour",
    theme: "--color-body-well",
  },
  // §09: the node footer's recessed background — the one region that has one,
  // and the only one that may contain controls (§08). Not a `--pr-body-*` glass
  // body in §18's sense; it sits over one.
  {
    name: "--pr-body-footer",
    value: "rgba(0,0,0,.18)",
    group: "colour",
    theme: "--color-body-footer",
  },

  // Not in §18: the family triple the surface recipes read. A node sets it to
  // its own `-rgb`, and attention or alert substitutes theirs (§03 STATES),
  // which is why no component needs to know about state combinations. Content is
  // the default because it is the family a graph cannot be without.
  { name: "--pr-hue", value: "var(--pr-content-rgb)", group: "colour" },

  {
    name: "--pr-content",
    value: "#6aaee0",
    group: "colour",
    theme: "--color-content",
  },
  // The triple, for the recipes' `rgba(hue, …)`. Never aliased to a Tailwind
  // colour: it is not a colour value.
  { name: "--pr-content-rgb", value: "106,174,224", group: "colour" },
  {
    name: "--pr-content-icon",
    value: "#8cc0e8",
    group: "colour",
    theme: "--color-content-icon",
  },

  {
    name: "--pr-command",
    value: "#a893e8",
    group: "colour",
    theme: "--color-command",
  },
  { name: "--pr-command-rgb", value: "168,147,232", group: "colour" },
  {
    name: "--pr-command-icon",
    value: "#c0aef2",
    group: "colour",
    theme: "--color-command-icon",
  },

  {
    name: "--pr-session",
    value: "#72c491",
    group: "colour",
    theme: "--color-session",
  },
  { name: "--pr-session-rgb", value: "114,196,145", group: "colour" },
  {
    name: "--pr-session-icon",
    value: "#93d4ab",
    group: "colour",
    theme: "--color-session-icon",
  },

  // §01: a cool spectrum with one warm outlier for the container.
  {
    name: "--pr-workstream",
    value: "#c9a173",
    group: "colour",
    theme: "--color-workstream",
  },
  { name: "--pr-workstream-rgb", value: "201,161,115", group: "colour" },
  {
    name: "--pr-workstream-icon",
    value: "#d9b98f",
    group: "colour",
    theme: "--color-workstream-icon",
  },

  // Reserved. §01: when a node needs a human, amber replaces its type hue
  // everywhere, which is why attention outranks type without an extra rule. At
  // most twice per card, once in the chrome, and never a type tint.
  {
    name: "--pr-attention",
    value: "#f7a441",
    group: "colour",
    theme: "--color-attention",
  },
  { name: "--pr-attention-rgb", value: "247,164,65", group: "colour" },
  {
    name: "--pr-attention-hi",
    value: "#f8c887",
    group: "colour",
    theme: "--color-attention-hi",
  },
  // Text on amber only. §15: this pairing clears 4.5:1.
  {
    name: "--pr-on-attention",
    value: "#231404",
    group: "colour",
    theme: "--color-on-attention",
  },

  // Reserved for failure, stop and refused — never a type tint.
  {
    name: "--pr-alert",
    value: "#e0655a",
    group: "colour",
    theme: "--color-alert",
  },
  { name: "--pr-alert-rgb", value: "224,101,90", group: "colour" },
  {
    name: "--pr-alert-hi",
    value: "#e88b82",
    group: "colour",
    theme: "--color-alert-hi",
  },

  // §03: selection is the one state drawn in white, and the only one that adds
  // geometry (ports).
  {
    name: "--pr-selection",
    value: "#e6e9ec",
    group: "colour",
    theme: "--color-selection",
  },
  // The triple, so the selection halo references this colour rather than
  // restating it. §18 uses the same convention for the four family hues.
  { name: "--pr-selection-rgb", value: "230,233,236", group: "colour" },

  // Node and panel titles.
  {
    name: "--pr-text-hi",
    value: "#f2f4f6",
    group: "colour",
    theme: "--color-text-hi",
  },
  // Values you compare across nodes. The base triple differs from steps 2–5;
  // that is the export's, not a transcription slip.
  {
    name: "--pr-text-1",
    value: "rgba(242,244,246,.92)",
    group: "colour",
    theme: "--color-text-1",
  },
  // Body mono.
  {
    name: "--pr-text-2",
    value: "rgba(228,231,235,.72)",
    group: "colour",
    theme: "--color-text-2",
  },
  // Chrome and labels. §15: hi through .56 clear 4.5:1 on every glass body.
  {
    name: "--pr-text-3",
    value: "rgba(228,231,235,.56)",
    group: "colour",
    theme: "--color-text-3",
  },
  // The live line, units, region keys. §15: does not clear 4.5:1, so never a
  // value the operator must read to make a decision.
  {
    name: "--pr-text-4",
    value: "rgba(228,231,235,.44)",
    group: "colour",
    theme: "--color-text-4",
  },
  // Caps, footnotes, provenance. Same contrast restriction as step 4.
  {
    name: "--pr-text-5",
    value: "rgba(228,231,235,.34)",
    group: "colour",
    theme: "--color-text-5",
  },

  {
    name: "--pr-fill-1",
    value: "rgba(255,255,255,.035)",
    group: "colour",
    theme: "--color-fill-1",
  },
  // Control rest. §10: hover goes to fill-3, press to fill-4.
  {
    name: "--pr-fill-2",
    value: "rgba(255,255,255,.055)",
    group: "colour",
    theme: "--color-fill-2",
  },
  {
    name: "--pr-fill-3",
    value: "rgba(255,255,255,.09)",
    group: "colour",
    theme: "--color-fill-3",
  },
  // §02: also the selected medium chip, which goes neutral rather than colour.
  {
    name: "--pr-fill-4",
    value: "rgba(255,255,255,.14)",
    group: "colour",
    theme: "--color-fill-4",
  },

  {
    name: "--pr-edge",
    value: "rgba(255,255,255,.10)",
    group: "colour",
    theme: "--color-edge",
  },
  {
    name: "--pr-edge-strong",
    value: "rgba(255,255,255,.16)",
    group: "colour",
    theme: "--color-edge-strong",
  },
  {
    name: "--pr-edge-soft",
    value: "rgba(255,255,255,.07)",
    group: "colour",
    theme: "--color-edge-soft",
  },
  {
    name: "--pr-edge-hair",
    value: "rgba(255,255,255,.045)",
    group: "colour",
    theme: "--color-edge-hair",
  },

  {
    name: "--pr-lip",
    value: "rgba(255,255,255,.16)",
    group: "colour",
    theme: "--color-lip",
  },
  // §01 GLASS: the lip is a single top highlight, never a full ring — a ring
  // reads as a glow and flattens the stack.
  {
    name: "--pr-lip-strong",
    value: "rgba(255,255,255,.22)",
    group: "colour",
    theme: "--color-lip-strong",
  },

  {
    name: "--pr-divider-color",
    value: "rgba(0,0,0,.28)",
    group: "colour",
    theme: "--color-divider",
  },

  // §04: every edge stays here so a dense graph still reads as background
  // structure.
  {
    name: "--pr-edge-line",
    value: "rgba(220,226,233,.34)",
    group: "colour",
    theme: "--color-edge-line",
  },
  {
    name: "--pr-edge-line-strong",
    value: "rgba(220,226,233,.50)",
    group: "colour",
    theme: "--color-edge-line-strong",
  },
  // §04: only the route out of the current selection is allowed to be bright.
  {
    name: "--pr-edge-line-active",
    value: "#e6e9ec",
    group: "colour",
    theme: "--color-edge-line-active",
  },

  /* -------------------------------------------------------------------- type */

  // §02: human sentences only. Weights 400 · 500 · 600.
  {
    name: "--pr-font-sans",
    value: "'Familjen Grotesk', system-ui, sans-serif",
    group: "type",
    theme: "--font-sans",
  },
  // §02: ids, labels, states, every number. Weights 400 · 500. Numbers are
  // always mono, with no exceptions.
  {
    name: "--pr-font-mono",
    value: "'JetBrains Mono', ui-monospace, monospace",
    group: "type",
    theme: "--font-mono",
  },

  // The KIND label. Pair with `--pr-ls-kind`: a `font` shorthand cannot carry
  // letter-spacing, which is why §18 lists the two separately.
  {
    name: "--pr-type-kind",
    value: "500 9.5px/1 var(--pr-font-mono)",
    group: "type",
  },
  // Section labels. The same shorthand as `--pr-type-kind`; the difference is
  // `--pr-ls-section`.
  {
    name: "--pr-type-section",
    value: "500 9.5px/1 var(--pr-font-mono)",
    group: "type",
  },
  // The live line.
  {
    name: "--pr-type-meta",
    value: "400 9.5px/1.4 var(--pr-font-mono)",
    group: "type",
  },
  // Region labels.
  {
    name: "--pr-type-meta-sm",
    value: "400 9px/1.4 var(--pr-font-mono)",
    group: "type",
  },
  // Spec rows, tool calls.
  {
    name: "--pr-type-mono",
    value: "400 10.5px/1.5 var(--pr-font-mono)",
    group: "type",
  },
  // The bars.
  {
    name: "--pr-type-chrome",
    value: "400 11.5px/1 var(--pr-font-mono)",
    group: "type",
  },
  // Content titles.
  {
    name: "--pr-type-title",
    value: "500 12.5px/1.35 var(--pr-font-sans)",
    group: "type",
  },
  // Graph identities.
  {
    name: "--pr-type-title-strong",
    value: "600 12.5px/1.35 var(--pr-font-sans)",
    group: "type",
  },
  // Panel headers — §06: the one place a heading is not mono.
  {
    name: "--pr-type-panel",
    value: "600 13px/1 var(--pr-font-sans)",
    group: "type",
  },
  // The frame band name. §17: a workstream's identity is the last thing you
  // should lose, so this survives to far zoom.
  {
    name: "--pr-type-node-id",
    value: "600 14px/1 var(--pr-font-sans)",
    group: "type",
  },
  // Prose, messages.
  {
    name: "--pr-type-body",
    value: "400 11.5px/1.5 var(--pr-font-sans)",
    group: "type",
  },
  // The wordmark. Its letter-spacing is `--pr-ls-brand`, not one of the three
  // `--pr-ls-*` steps — §18 states it inline on this row, and §07 records that
  // the lockup is a placeholder rather than a decision.
  {
    name: "--pr-type-brand",
    value: "600 14.5px/1 var(--pr-font-sans)",
    group: "type",
  },

  { name: "--pr-ls-kind", value: ".08em", group: "type" },
  { name: "--pr-ls-section", value: ".12em", group: "type" },
  { name: "--pr-ls-heading", value: "-.01em", group: "type" },
  { name: "--pr-ls-brand", value: "-.012em", group: "type" },

  /* ------------------------------------------------------------------ motion */

  // §01: the only easing. Nothing scales, bounces, or pulses — a running session
  // is signalled by its dot and its numbers moving. Named `--ease-pr` rather
  // than overriding one of Tailwind's, because it is the system's easing and not
  // a variant of anything.
  {
    name: "--pr-ease",
    value: "cubic-bezier(.2,.6,.2,1)",
    group: "motion",
    theme: "--ease-pr",
  },
  // §10: 90ms in, 90ms out, and only background-color and border-color
  // transition. The namespace is `--transition-duration-*`; a `--duration-*`
  // alias looks right and generates nothing at all.
  {
    name: "--pr-dur-hover",
    value: "90ms",
    group: "motion",
    theme: "--transition-duration-hover",
  },
  // State change (tint cross-fade), and §13's node settle after a grid snap.
  {
    name: "--pr-dur-state",
    value: "160ms",
    group: "motion",
    theme: "--transition-duration-state",
  },
  // §14: the zoom level change — width and radius, with edges re-routing in the
  // same window. §14 also fixes what does not animate: the header never
  // cross-fades, because identity must not move as the card grows.
  {
    name: "--pr-dur-lod",
    value: "220ms",
    group: "motion",
    theme: "--transition-duration-lod",
  },

  /* -------------------------------------------------------- space and radius */

  // The scale is deliberately non-linear, so it is not aliased onto Tailwind's
  // `--spacing-*` namespace — `p-4` meaning 9px would break every reader's
  // expectation. Spacing is a variant on the layout primitives (#102).
  { name: "--pr-space-1", value: "4px", group: "size" },
  { name: "--pr-space-2", value: "6px", group: "size" },
  { name: "--pr-space-3", value: "8px", group: "size" },
  { name: "--pr-space-4", value: "9px", group: "size" },
  { name: "--pr-space-5", value: "11px", group: "size" },
  { name: "--pr-space-6", value: "12px", group: "size" },
  { name: "--pr-space-7", value: "14px", group: "size" },
  { name: "--pr-space-8", value: "16px", group: "size" },
  { name: "--pr-space-9", value: "18px", group: "size" },
  { name: "--pr-space-10", value: "20px", group: "size" },
  { name: "--pr-space-11", value: "24px", group: "size" },
  { name: "--pr-space-12", value: "28px", group: "size" },

  // §01: radius climbs with rank in the graph.
  {
    name: "--pr-radius-chip",
    value: "6px",
    group: "size",
    theme: "--radius-chip",
  },
  {
    name: "--pr-radius-control",
    value: "7px",
    group: "size",
    theme: "--radius-control",
  },
  // Also palette rows.
  {
    name: "--pr-radius-far",
    value: "9px",
    group: "size",
    theme: "--radius-far",
  },
  // Wells, tool calls, the question card.
  {
    name: "--pr-radius-block",
    value: "10px",
    group: "size",
    theme: "--radius-block",
  },
  {
    name: "--pr-radius-node",
    value: "11px",
    group: "size",
    theme: "--radius-node",
  },
  // Also the rail.
  {
    name: "--pr-radius-node-full",
    value: "12px",
    group: "size",
    theme: "--radius-node-full",
  },
  {
    name: "--pr-radius-panel",
    value: "14px",
    group: "size",
    theme: "--radius-panel",
  },
  // §04: a larger radius than the nodes inside it, so the frame reads as ground
  // rather than another card.
  {
    name: "--pr-radius-frame",
    value: "16px",
    group: "size",
    theme: "--radius-frame",
  },

  /* ---------------------------------------------------------------- geometry */

  // §14: below 45% zoom. Identity only — you are navigating, not reading.
  { name: "--pr-node-far-w", value: "150px", group: "geometry" },
  // The far node is the one size fixed in both axes; §09 states that mid and
  // full heights are content-driven, never fixed, which is why there is no
  // minimum-height token to go with these widths.
  { name: "--pr-node-far-h", value: "34px", group: "geometry" },
  // §14: 45–80%. The reading level.
  { name: "--pr-node-mid-w", value: "268px", group: "geometry" },
  // §14: above 80%, and the only level you can act inside.
  { name: "--pr-node-full-w", value: "340px", group: "geometry" },
  // Node header and frame band.
  { name: "--pr-header-h", value: "40px", group: "geometry" },
  // §09: the mid variant's header is 36 by its 9/12 padding rather than a fixed
  // height. Named because it is still a measured size.
  { name: "--pr-header-h-mid", value: "36px", group: "geometry" },
  // §09: title padding 9 12 0, live-line padding 6 12 10, and the title never
  // wraps — which is what makes this a fixed number.
  { name: "--pr-title-block-h", value: "57px", group: "geometry" },
  // The node footer — §08: the only region that may contain controls, and the
  // only one with a recessed background.
  { name: "--pr-footer-h", value: "44px", group: "geometry" },
  // The frame's footer strip. §18 gives both heights one name; a custom property
  // holds one value.
  { name: "--pr-footer-h-frame", value: "32px", group: "geometry" },
  // §09: header, title block, region and footer all inset 12 horizontally.
  { name: "--pr-node-pad-x", value: "12px", group: "geometry" },
  // §09: the far node's padding is 0 10.
  { name: "--pr-node-pad-x-far", value: "10px", group: "geometry" },
  // §09: the header's slot gap, and the far node's. §03: slot order never
  // changes, in any family, at any zoom.
  { name: "--pr-node-header-gap", value: "8px", group: "geometry" },
  // §09: region padding is 10 12.
  { name: "--pr-region-pad-y", value: "10px", group: "geometry" },
  // §09: a region's internal gap, its label-to-first-row gap, and the footer's
  // control gap.
  { name: "--pr-region-gap", value: "7px", group: "geometry" },
  // §08: fixed, so values align down the card.
  { name: "--pr-region-key-w", value: "64px", group: "geometry" },
  // §09: the key/value gap.
  { name: "--pr-region-key-gap", value: "10px", group: "geometry" },
  // §09: the band and the footer strip both inset 16, hence no `-band` in the
  // name — their gaps differ, their padding does not.
  { name: "--pr-frame-pad-x", value: "16px", group: "geometry" },
  { name: "--pr-frame-band-gap", value: "9px", group: "geometry" },
  // §04: counts left, spend right, always that order.
  { name: "--pr-frame-strip-gap", value: "12px", group: "geometry" },
  // §09: children sit at least 24 from the frame's left and right edges, below
  // the band and above the strip. The frame is the bounding box of its children
  // plus this — it has no fixed size and no minimum beyond one child.
  { name: "--pr-frame-pad", value: "24px", group: "geometry" },
  // §09: the minimum between sibling nodes in either axis. A solver input.
  { name: "--pr-frame-child-gap", value: "16px", group: "geometry" },
  // §09: horizontally when an edge runs between two children, so the arrowhead
  // has room. A solver input.
  { name: "--pr-frame-child-gap-edge", value: "42px", group: "geometry" },
  // §13: a new session appears this far below its command, forks fanning left to
  // right in creation order. The one automatic placement in the product.
  { name: "--pr-session-offset-y", value: "140px", group: "geometry" },
  // §09: a selected node's ports, centred on the top and bottom edges. Geometry
  // rather than decoration — they are the one state that adds any, and they
  // extend the node's hit area by 5px vertically, which is a measured size.
  { name: "--pr-port-size", value: "8px", group: "geometry" },
  { name: "--pr-port-offset", value: "-5px", group: "geometry" },
  // §13: snap pitch and dot pitch, the same value — the dots are the snap
  // targets. Snapped on release, never during drag.
  { name: "--pr-grid", value: "28px", group: "geometry" },

  /* ------------------------------------------------------------ chrome sizes */

  // §15: both bars are fixed at 42 at every window size, and never scale with
  // the graph.
  { name: "--pr-chrome-h", value: "42px", group: "size" },
  { name: "--pr-rail-w", value: "44px", group: "size" },
  // §18 states this beside `--pr-rail-w`; named because it is a second value.
  { name: "--pr-rail-button", value: "28px", group: "size" },
  // Chrome and node footers.
  { name: "--pr-control-h", value: "26px", group: "size" },
  // Floating over the canvas. §15: controls are 26–30px, below the 44px touch
  // guideline, because every control also has a shortcut — which is the
  // accessible path.
  { name: "--pr-control-h-floating", value: "30px", group: "size" },
  // §15: panel widths are fixed and never fluid; they gain height, not width.
  { name: "--pr-panel-palette-w", value: "226px", group: "size" },
  { name: "--pr-panel-conversation-w", value: "356px", group: "size" },

  /* ----------------------------------------------------------------- surface */

  // §01's six-part recipe, parts 1 and 2. 158° is deliberate. §10: hover lifts
  // the top stop to .17 and press drops it to .11 — background and border only,
  // never a transform.
  {
    name: "--pr-glass",
    value:
      "linear-gradient(158deg, rgba(var(--pr-hue),.14), rgba(255,255,255,.012) 45%, rgba(var(--pr-hue),.05)), var(--pr-body-node)",
    group: "surface",
  },
  // Part 3.
  {
    name: "--pr-glass-border",
    value: "1px solid rgba(var(--pr-hue),.32)",
    group: "surface",
  },
  // §03: state is a hue substitution plus a border weight, and nothing more —
  // this is the weight. §18 states the .45 inside `--pr-glass-border`'s row; a
  // component that had to know the number would be the second place the rule
  // lived.
  {
    name: "--pr-glass-border-signal",
    value: "1px solid rgba(var(--pr-hue),.45)",
    group: "surface",
  },
  // §04: the frame's border is lighter than a node's, and rises to the signal
  // weight above when its rollup is amber.
  {
    name: "--pr-glass-border-frame",
    value: "1px solid rgba(var(--pr-hue),.28)",
    group: "surface",
  },
  // Panels carry no type hue: they are tools beside the graph, not part of it.
  {
    name: "--pr-glass-panel",
    value:
      "linear-gradient(165deg, rgba(255,255,255,.065), rgba(255,255,255,.008) 50%, rgba(255,255,255,.035)), var(--pr-body-panel)",
    group: "surface",
  },
  // Half the node's tint (§04), so the frame reads as ground.
  {
    name: "--pr-glass-frame",
    value:
      "linear-gradient(158deg, rgba(var(--pr-hue),.075), rgba(255,255,255,.008) 45%, rgba(var(--pr-hue),.03)), var(--pr-body-frame)",
    group: "surface",
  },
  // §16: no hue until the data arrives, so colour never lies. Part of the
  // newly-designed section — a proposal, not a committed decision.
  {
    name: "--pr-glass-loading",
    value:
      "linear-gradient(158deg, rgba(255,255,255,.04), rgba(255,255,255,.008) 45%, rgba(255,255,255,.025)), var(--pr-body-node)",
    group: "surface",
  },

  // Part 6. §01: the saturation lift is what keeps the wash alive behind the
  // glass; drop it and every surface turns grey. §15: dropped entirely under
  // reduced-transparency, where each body goes opaque over `--pr-canvas`. Not
  // aliased to Tailwind's `--blur-*`, which expects a bare length and wraps it in
  // `blur()`.
  {
    name: "--pr-blur-node",
    value: "blur(24px) saturate(1.4)",
    group: "surface",
  },
  {
    name: "--pr-blur-panel",
    value: "blur(30px) saturate(1.4)",
    group: "surface",
  },
  {
    name: "--pr-blur-chrome",
    value: "blur(28px) saturate(1.3)",
    group: "surface",
  },

  // §01 GLASS part 4 is the strong lip; this is the same highlight at the
  // lighter step. Both reference `--pr-lip*` rather than restating its value —
  // one value, one place, or the two can disagree.
  {
    name: "--pr-shadow-lip",
    value: "inset 0 1px 0 var(--pr-lip)",
    group: "surface",
    theme: "--inset-shadow-lip",
  },
  // Part 4: top only, never a full ring.
  {
    name: "--pr-shadow-lip-strong",
    value: "inset 0 1px 0 var(--pr-lip-strong)",
    group: "surface",
    theme: "--inset-shadow-lip-strong",
  },
  // §01 DEPTH: attached.
  {
    name: "--pr-shadow-flat",
    value: "0 3px 10px rgba(0,0,0,.25)",
    group: "surface",
    theme: "--shadow-flat",
  },
  {
    name: "--pr-shadow-node",
    value: "0 8px 22px rgba(0,0,0,.38)",
    group: "surface",
    theme: "--shadow-node",
  },
  // Part 5 of the glass recipe.
  {
    name: "--pr-shadow-node-full",
    value: "0 10px 26px rgba(0,0,0,.40)",
    group: "surface",
    theme: "--shadow-node-full",
  },
  // Also the drag ghost's shadow (§10).
  {
    name: "--pr-shadow-frame",
    value: "0 18px 44px rgba(0,0,0,.45)",
    group: "surface",
    theme: "--shadow-frame",
  },
  // §06: the heaviest shadow in the system — panels float, never dock.
  {
    name: "--pr-shadow-panel",
    value: "0 18px 44px rgba(0,0,0,.50)",
    group: "surface",
    theme: "--shadow-panel",
  },
  // One step down: an input is darker than its container.
  {
    name: "--pr-shadow-well",
    value: "inset 0 1px 3px rgba(0,0,0,.30)",
    group: "surface",
    theme: "--inset-shadow-well",
  },

  // §18's `--pr-divider` is a pair — `border-bottom: 1px var(--pr-divider-color)`
  // plus this shadow. Two declarations cannot be one custom property.
  {
    name: "--pr-divider-shadow",
    value: "0 1px 0 rgba(255,255,255,.05)",
    group: "surface",
  },
  // §09: the extra 0.5px comes out of the padding box, so selecting a node does
  // not shift layout.
  {
    name: "--pr-select-border",
    value: "1.5px solid var(--pr-selection)",
    group: "surface",
  },
  // §16: the primary member of a multi-selection keeps this; secondary members
  // get the border only, and no ports.
  {
    name: "--pr-select-halo",
    value: "0 0 0 3px rgba(var(--pr-selection-rgb),.10)",
    group: "surface",
  },
  // §15: deliberately louder than the selection edge, on every focusable
  // element, and never suppressed.
  {
    name: "--pr-focus-ring",
    value: "2px solid var(--pr-selection)",
    group: "surface",
  },
  // §18 states the offset inline with the ring; an `outline-offset` is its own
  // declaration.
  { name: "--pr-focus-ring-offset", value: "2px", group: "surface" },
  // A closed lifecycle: dashed, untinted, glyph desaturated (§03). Contents stay
  // legible but nothing inside is actionable.
  {
    name: "--pr-ghost-border",
    value: "1.5px dashed rgba(228,231,235,.2)",
    group: "surface",
  },
  // The fill §18 states beneath `--pr-ghost-border`.
  {
    name: "--pr-ghost-fill",
    value: "rgba(255,255,255,.018)",
    group: "surface",
  },
];
