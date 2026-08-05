import { DESIGN_TOKENS, type DesignToken, type TokenGroup } from "./tokens.js";

/**
 * The token table's CSS half (decision 0002 §1): one source, two outputs.
 *
 * `tokens.ts` is the source. This renders it into `theme.generated.css`, which
 * `toolkit.css` imports, and `theme.ts` renders the same array into the plugin
 * SDK's `Theme.tokens`. Neither output restates a value, so they cannot
 * disagree — and because the generated file is committed, a design change lands
 * as a reviewable CSS diff, which is the reason decision 0002 chose tokens as
 * custom properties in the first place.
 *
 * The output is two blocks, and the split is load-bearing:
 *
 * - **`:root`** holds every `--pr-*` property. It is plain CSS, not a `@theme`
 *   block, so Tailwind's unused-variable tree-shaking cannot prune it: the
 *   tokens are the product's vocabulary whether or not a utility happens to use
 *   one, and a plugin's theme override has to have something to override.
 * - **`@theme inline`** aliases Tailwind's namespaces onto those properties.
 *   `inline` makes a utility emit `var(--pr-canvas)` rather than
 *   `var(--color-canvas)` — one indirection instead of two — which is what makes
 *   overriding a single `--pr-*` property reach every consumer of it with no
 *   component edit and no rebuild. Without `inline`, `var(--color-canvas)`
 *   resolves where Tailwind defined it (`:root`), so an override applied deeper
 *   in the tree would be ignored.
 */

/** Header comment: the generated file says where it comes from. */
const HEADER = `/**
 * Generated from \`src/tokens.ts\` by \`renderThemeCss\` — do not edit.
 *
 * Regenerate with \`pnpm --filter @plotroom/toolkit build\`; \`theme.css.test.ts\`
 * fails if this file and the token table have drifted apart.
 */`;

/** §18's own order, so the generated file reads like the export's table. */
const GROUP_ORDER: readonly TokenGroup[] = [
  "colour",
  "type",
  "motion",
  "size",
  "geometry",
  "surface",
];

const GROUP_LABEL: Readonly<Record<TokenGroup, string>> = {
  colour: "§18 colour",
  type: "§18 type",
  motion: "§18 motion",
  size: "§18 space, radius, size",
  geometry: "§09 redlines — measured geometry the layout solver consumes",
  surface: "§18 surface recipes",
};

/**
 * Render the token table as CSS.
 *
 * Throws on a duplicate `--pr-*` name or a duplicate Tailwind theme key: two
 * rows claiming one name is a merge accident, and the last-one-wins CSS that
 * would result is exactly the kind of silent disagreement this file exists to
 * prevent.
 */
export function renderThemeCss(
  tokens: readonly DesignToken[] = DESIGN_TOKENS,
): string {
  assertUnique(tokens);

  const lines: string[] = [HEADER, "", ":root {"];

  for (const group of GROUP_ORDER) {
    const members = tokens.filter((token) => token.group === group);
    if (members.length === 0) continue;
    lines.push(`  /* ${GROUP_LABEL[group]} */`);
    for (const token of members) {
      lines.push(`  ${token.name}: ${token.value};`);
    }
    lines.push("");
  }

  // The group loop leaves a separator behind the last group; drop it rather than
  // close the block on a blank line. Nothing else formats this file — it is
  // `.prettierignore`d, because prettier would rewrite `rgba(18,20,23,.40)` into
  // the same colour and a different number from the one §18 states.
  if (lines.at(-1) === "") lines.pop();
  lines.push("}", "");

  const aliased = tokens.filter(
    (token): token is DesignToken & { theme: `--${string}` } =>
      token.theme !== undefined,
  );
  lines.push("@theme inline {");
  for (const group of GROUP_ORDER) {
    const members = aliased.filter((token) => token.group === group);
    if (members.length === 0) continue;
    lines.push(`  /* ${GROUP_LABEL[group]} */`);
    for (const token of members) {
      lines.push(`  ${token.theme}: var(${token.name});`);
    }
    lines.push("");
  }
  if (lines.at(-1) === "") lines.pop();
  lines.push("}", "");

  return lines.join("\n");
}

/**
 * Whether two renderings of the stylesheet are the same **content**.
 *
 * Line endings are not content. This repository has no `.gitattributes`, so a
 * Windows checkout has CRLF on disk while `renderThemeCss` emits LF — and a
 * staleness gate that read that as a design change made the package unbuildable
 * on Windows for a difference nobody made. Both the build's check and the test's
 * call this, so they cannot disagree about what "stale" means.
 */
export function sameContent(a: string, b: string): boolean {
  return a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");
}

function assertUnique(tokens: readonly DesignToken[]): void {
  const names = new Set<string>();
  const themeKeys = new Set<string>();
  for (const token of tokens) {
    if (names.has(token.name)) {
      throw new Error(`duplicate token name: ${token.name}`);
    }
    names.add(token.name);
    if (token.theme === undefined) continue;
    if (themeKeys.has(token.theme)) {
      throw new Error(`duplicate Tailwind theme key: ${token.theme}`);
    }
    themeKeys.add(token.theme);
  }
}
