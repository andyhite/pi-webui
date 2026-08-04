import { describe, expect, it } from "vitest";

import type { ScopeChainNode } from "./scope.js";
import { activeScopes } from "./scope.js";

function chain(...scopes: readonly (string | null)[]): ScopeChainNode {
  // Innermost first, as `scopeChainFromElement` builds it.
  return scopes.reduceRight<ScopeChainNode | null>(
    (parent, scope) => ({ scope, parent }),
    null,
  ) as ScopeChainNode;
}

describe("activeScopes", () => {
  it("adds global when nothing declares a scope — the app's own verbs are always live", () => {
    expect(activeScopes(chain(null, null))).toEqual(["global"]);
    expect(activeScopes(null)).toEqual(["global"]);
  });

  it("reports declared scopes innermost first, plus global", () => {
    expect(activeScopes(chain("queue", null, "canvas"))).toEqual([
      "queue",
      "canvas",
      "global",
    ]);
  });

  it("drops global inside a dialog — a bare `r` must not run something behind the modal", () => {
    expect(activeScopes(chain(null, "dialog"))).toEqual(["dialog"]);
  });

  it("ignores an unknown scope value rather than inventing a sixth scope", () => {
    expect(activeScopes(chain("not-a-scope", "queue"))).toEqual([
      "queue",
      "global",
    ]);
  });

  it("de-duplicates a nested repeat of the same scope", () => {
    expect(activeScopes(chain("list", "list"))).toEqual(["list", "global"]);
  });
});
