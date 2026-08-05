import { describe, expect, it } from "vitest";

import { PLOTROOM_THEME } from "./theme.js";
import { DESIGN_TOKENS } from "./tokens.js";

/**
 * The token table's own invariants. None of these are style preferences: each
 * one is a way the table can be wrong that nothing else would notice.
 */
describe("the token table", () => {
  it("names every token with the export's `--pr-` prefix", () => {
    const wrong = DESIGN_TOKENS.filter(
      (token) => !token.name.startsWith("--pr-"),
    );
    expect(wrong).toEqual([]);
  });

  it("names each token once", () => {
    const names = DESIGN_TOKENS.map((token) => token.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("claims each Tailwind theme key once", () => {
    const keys = DESIGN_TOKENS.flatMap((token) =>
      token.theme === undefined ? [] : [token.theme],
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  /**
   * A recipe reaching for a token that does not exist is a stylesheet with a
   * hole in it: `rgba(var(--pr-hue), .14)` with no `--pr-hue` is an invalid
   * declaration, which CSS drops in silence.
   */
  it("only references tokens it also defines", () => {
    const defined = new Set<string>(DESIGN_TOKENS.map((token) => token.name));
    const dangling: string[] = [];
    for (const token of DESIGN_TOKENS) {
      for (const [, referenced] of token.value.matchAll(
        /var\((--pr-[\w-]+)\)/g,
      )) {
        if (referenced !== undefined && !defined.has(referenced)) {
          dangling.push(`${token.name} -> ${referenced}`);
        }
      }
    }
    expect(dangling).toEqual([]);
  });

  it("gives every token a value", () => {
    const empty = DESIGN_TOKENS.filter((token) => token.value.trim() === "");
    expect(empty).toEqual([]);
  });

  /**
   * §18: "Every number is exact and measured at 1440 × 900. Odd values (9, 11,
   * 12.5, 158°) are deliberate — do not round them." The four that a tidying
   * pass would most plausibly round are pinned here by value.
   */
  it("keeps the deliberately odd numbers unrounded", () => {
    const { tokens } = PLOTROOM_THEME;
    expect(tokens["--pr-space-4"]).toBe("9px");
    expect(tokens["--pr-space-5"]).toBe("11px");
    expect(tokens["--pr-radius-far"]).toBe("9px");
    expect(tokens["--pr-radius-node"]).toBe("11px");
    expect(tokens["--pr-type-title"]).toContain("12.5px");
    expect(tokens["--pr-glass"]).toContain("158deg");
  });

  /**
   * §01: the hue is carried in the glass gradient and the border, "so one value
   * decides a node's whole colour story". If a recipe ever inlined a family's
   * colour instead of reading `--pr-hue`, per-type colour and the amber
   * substitution that outranks it would both stop working from one place.
   */
  it("carries the family hue through --pr-hue rather than a literal", () => {
    for (const name of [
      "--pr-glass",
      "--pr-glass-border",
      "--pr-glass-frame",
    ]) {
      expect(PLOTROOM_THEME.tokens[name]).toContain("var(--pr-hue)");
    }
    for (const family of ["content", "command", "session", "workstream"]) {
      expect(PLOTROOM_THEME.tokens["--pr-glass"]).not.toContain(
        PLOTROOM_THEME.tokens[`--pr-${family}-rgb`] ?? "unreachable",
      );
    }
  });
});

describe("the theme map", () => {
  it("carries every token, keyed by its custom-property name", () => {
    expect(Object.keys(PLOTROOM_THEME.tokens)).toHaveLength(
      DESIGN_TOKENS.length,
    );
    for (const token of DESIGN_TOKENS) {
      expect(PLOTROOM_THEME.tokens[token.name]).toBe(token.value);
    }
  });

  it("is frozen, because the SDK's Theme.tokens is", () => {
    expect(Object.isFrozen(PLOTROOM_THEME.tokens)).toBe(true);
  });
});
