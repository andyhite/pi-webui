/**
 * `@plotroom/toolkit` — PlotRoom's design system as a package.
 *
 * Track 1 of #86 is the seam: the token layer, the build that emits one
 * stylesheet, and the rule that this package depends on nothing else in the
 * workspace. Primitives are #102 and the gallery is #103.
 *
 * The visual source of truth is the Claude Design export in
 * `docs/design/exports/2026-08-04/`, re-implemented here rather than adopted
 * (decision 0002). Its §18 names every value; `tokens.ts` is that table.
 *
 * Consumers import two things: this module for the typed tokens, and
 * `@plotroom/toolkit/toolkit.css` — once, at the app entry — for the stylesheet
 * the tokens and Tailwind's utilities live in.
 */

export { DESIGN_TOKENS } from "./tokens.js";
export type { DesignToken, TokenGroup } from "./tokens.js";
export { PLOTROOM_THEME, PLOTROOM_THEME_ID } from "./theme.js";
export type { TokenTheme } from "./theme.js";
