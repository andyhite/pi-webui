import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";

import { renderThemeCss, sameContent } from "./theme.css.js";
import { DESIGN_TOKENS, type DesignToken } from "./tokens.js";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Tailwind resolves `@import` through a caller-supplied loader, so the test
 * compiles the *real* `toolkit.css` rather than a paraphrase of it: an assertion
 * about a stylesheet nobody ships proves nothing.
 */
async function loadStylesheet(
  id: string,
  base: string,
): Promise<{ path: string; base: string; content: string }> {
  const file = id.startsWith(".")
    ? path.resolve(base, id)
    : require.resolve(id);
  return {
    path: file,
    base: path.dirname(file),
    content: await readFile(file, "utf8"),
  };
}

/** Build the shipped stylesheet for an explicit candidate list. */
async function buildToolkitCss(candidates: readonly string[]): Promise<string> {
  const entry = path.join(HERE, "toolkit.css");
  const compiler = await compile(await readFile(entry, "utf8"), {
    base: HERE,
    loadStylesheet,
  });
  return compiler.build([...candidates]);
}

/**
 * A Tailwind namespace, and the utility prefix that proves it exists.
 *
 * Longest prefix wins, so `--inset-shadow-*` is not read as `--shadow-*`.
 */
const UTILITY_PREFIX: Readonly<Record<string, string>> = {
  "--color-": "bg-",
  "--radius-": "rounded-",
  "--font-": "font-",
  "--shadow-": "shadow-",
  "--inset-shadow-": "inset-shadow-",
  "--ease-": "ease-",
  "--transition-duration-": "duration-",
};

function candidateFor(token: DesignToken & { theme: string }): string {
  const namespaces = Object.keys(UTILITY_PREFIX).sort(
    (a, b) => b.length - a.length,
  );
  for (const namespace of namespaces) {
    if (!token.theme.startsWith(namespace)) continue;
    return `${UTILITY_PREFIX[namespace]}${token.theme.slice(namespace.length)}`;
  }
  throw new Error(
    `${token.name} aliases ${token.theme}, which is not a Tailwind namespace this test knows. ` +
      `Either the namespace is wrong (a bad alias generates nothing, in silence) or UTILITY_PREFIX needs the new one.`,
  );
}

const ALIASED = DESIGN_TOKENS.filter(
  (token): token is DesignToken & { theme: `--${string}` } =>
    token.theme !== undefined,
);

describe("theme.generated.css", () => {
  it("is what the token table renders", async () => {
    const committed = await readFile(
      path.join(HERE, "theme.generated.css"),
      "utf8",
    );
    // Content, not bytes — `sameContent` is what the build's own gate uses, so
    // the two cannot disagree about what "stale" means (a Windows checkout has
    // CRLF on disk and the renderer emits LF).
    expect(sameContent(committed, renderThemeCss())).toBe(true);
  });
});

describe("the shipped stylesheet", () => {
  /**
   * The acceptance criterion of #101, mechanically: overriding one token has to
   * reach every consumer of it with no component edit. That is only true if a
   * utility *references* the property instead of copying its value, which is
   * what `@theme inline` buys — and the way to prove it is that the value has
   * exactly one definition site in the whole stylesheet.
   */
  it("states a token's value once and references it everywhere else", async () => {
    const css = await buildToolkitCss(["bg-canvas", "text-canvas"]);

    expect(css).toContain("--pr-canvas: #101113;");
    const definitions = css.match(/#101113/g) ?? [];
    expect(definitions).toHaveLength(1);

    expect(css).toContain("background-color: var(--pr-canvas)");
    expect(css).toContain("color: var(--pr-canvas)");
  });

  /**
   * Plain `@theme` would emit `--color-canvas: var(--pr-canvas)` and make every
   * utility read *that* — a second indirection resolved where Tailwind defined
   * it, so an override applied deeper in the tree would be ignored. Its absence
   * is the difference between a token layer and a token-shaped one.
   */
  it("does not indirect through Tailwind's own theme variables", async () => {
    const css = await buildToolkitCss(["bg-canvas", "rounded-node"]);
    expect(css).not.toContain("--color-canvas:");
    expect(css).not.toContain("--radius-node:");
  });

  /**
   * Every alias earns a utility. A misspelled namespace is Tailwind's one real
   * failure mode — it generates nothing and says nothing (`--duration-hover`
   * looks right and is not the namespace; `--transition-duration-hover` is).
   *
   * The assertion is on the generated **selector**, not on a `var(--pr-*)`
   * reference: the `:root` block already references the tokens that other tokens
   * are composed from (`--pr-font-mono` through `--pr-type-*`, `--pr-body-node`
   * through the glass recipes), so a reference check passes for those six however
   * dead the alias is — and the fonts are exactly where a wrong namespace is most
   * plausible.
   */
  it("generates a working utility for every aliased token", async () => {
    const candidates = ALIASED.map(candidateFor);
    const css = await buildToolkitCss(candidates);
    const dead = ALIASED.filter((token, index) => {
      const candidate = candidates[index] ?? "";
      return (
        !css.includes(`.${candidate} {`) || !css.includes(`var(${token.name})`)
      );
    }).map((token) => `${token.theme} (${token.name})`);
    expect(dead).toEqual([]);
  });

  /**
   * Why the assertion above is on the selector and not on the reference: with no
   * candidates at all, the stylesheet already mentions the tokens that other
   * tokens are composed from, so "the sheet references `--pr-font-mono`" is not
   * evidence that `font-mono` generates anything. Six aliased tokens are in that
   * position, the two type faces among them.
   */
  it("does not mistake a token reference for a working utility", async () => {
    const nothing = await buildToolkitCss([]);
    expect(nothing).toContain("var(--pr-font-mono)");
    expect(nothing).toContain("var(--pr-body-node)");
    expect(nothing).not.toContain(".font-mono {");
    expect(nothing).not.toContain(".bg-body-node {");
  });

  /**
   * Decision 0002 §3: visual decisions cannot be made outside the toolkit. The
   * stylesheet enforces it rather than asking — Tailwind's default theme is
   * never imported, so the palette and scales the design did not choose do not
   * exist to reach for.
   */
  it("offers no colour, spacing or type value the design did not decide", async () => {
    const css = await buildToolkitCss([
      "bg-red-500",
      "text-slate-200",
      "p-4",
      "gap-2",
      "text-sm",
      "rounded-lg",
    ]);
    expect(css).not.toContain("bg-red-500");
    expect(css).not.toContain("text-slate-200");
    expect(css).not.toContain(".p-4");
    expect(css).not.toContain(".gap-2");
    expect(css).not.toContain(".text-sm");
    expect(css).not.toContain(".rounded-lg");
  });

  /**
   * Tailwind's reset is a global change to every element the renderer draws, and
   * the arrangement e2e gates measure real DOM sizes (decision 0002 §4). The
   * restyle re-baselines them once, visibly (#51); the token layer must not move
   * them at all.
   */
  it("ships no preflight, so importing it moves nothing", async () => {
    const css = await buildToolkitCss(["bg-canvas"]);
    expect(css).not.toContain("box-sizing: border-box");
    expect(css).not.toContain("::backdrop\n");
    expect(css).not.toMatch(/^\s*body\s*\{/m);
  });
});
