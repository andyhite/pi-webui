import { describe, expect, it } from "vitest";

import type { ScopeChainNode } from "./scope.js";
import { resolveKeyContext } from "./scope.js";

function chain(...scopes: readonly (string | null)[]): ScopeChainNode {
  // Innermost first, as `scopeChainFromElement` builds it.
  return scopes.reduceRight<ScopeChainNode | null>(
    (parent, scope) => ({ scope, parent }),
    null,
  ) as ScopeChainNode;
}

describe("resolveKeyContext", () => {
  it("adds global when nothing declares a scope — the app's own verbs are always live", () => {
    expect(resolveKeyContext(chain(null, null)).scopes).toEqual(["global"]);
    expect(resolveKeyContext(null).scopes).toEqual(["global"]);
  });

  it("reports declared scopes innermost first, plus global", () => {
    expect(resolveKeyContext(chain("queue", null, "canvas")).scopes).toEqual([
      "queue",
      "canvas",
      "global",
    ]);
  });

  it("drops global inside a dialog — a bare `r` must not run something behind the modal", () => {
    expect(resolveKeyContext(chain(null, "dialog")).scopes).toEqual(["dialog"]);
  });

  it("reads the surface beside the scope, so two dialogs' Escapes stay distinct", () => {
    const context = resolveKeyContext(chain("dialog:command-palette"));
    expect(context.scopes).toEqual(["dialog"]);
    expect(context.surfaces).toEqual(["command-palette"]);
  });

  it("ignores an unknown scope value rather than inventing a sixth scope", () => {
    expect(resolveKeyContext(chain("not-a-scope", "queue")).scopes).toEqual([
      "queue",
      "global",
    ]);
  });

  it("de-duplicates a nested repeat of the same scope and surface", () => {
    const context = resolveKeyContext(chain("list:palette", "list:palette"));
    expect(context.scopes).toEqual(["list", "global"]);
    expect(context.surfaces).toEqual(["palette"]);
  });

  it("reports text entry, so a letter verb never eats a typed character", () => {
    expect(
      resolveKeyContext({ scope: null, textEntry: true, parent: null })
        .inTextEntry,
    ).toBe(true);
  });
});
