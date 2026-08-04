/**
 * Which scopes are live, resolved from what has focus (§11). One rule, in
 * one place, so the single window-level dispatcher (`use-key-bindings.tsx`)
 * is the only keyboard listener the app needs: a surface declares its scope
 * in the DOM (`data-key-scope="queue"`), and this walks up from the focused
 * element to find it.
 *
 * A declaration may name the surface as well as the scope —
 * `data-key-scope="dialog:command-palette"` — because every dialog wants
 * Escape and every keyboard-navigable list wants the arrows. The surface is
 * what keeps those from being one binding shadowing another (`bindings.ts`'s
 * `surface`), while still letting all of them be registered, and therefore
 * documented, at once.
 *
 * `global` is included only when no `dialog` is in the chain: while a modal
 * has focus, a bare `r` must not run the selected node behind it. That is
 * the same fact the focus trap enforces from the other side — the trap keeps
 * focus inside, this keeps the bindings outside from firing.
 *
 * Pure over a `ScopeChainNode` shape rather than a real `Element`, so the
 * rules are unit-testable without a DOM.
 */

import type { DispatchContext, KeyScope } from "./bindings.js";
import { KEY_SCOPE_PRECEDENCE } from "./bindings.js";

/** The DOM attribute a surface declares its scope with. */
export const KEY_SCOPE_ATTRIBUTE = "data-key-scope";

/** The minimum of an element this module reads: its scope, and its parent. */
export interface ScopeChainNode {
  /** `<scope>` or `<scope>:<surface>`. */
  readonly scope?: string | null | undefined;
  readonly parent?: ScopeChainNode | null | undefined;
  /** True for input/textarea/contenteditable — suppresses letter bindings. */
  readonly textEntry?: boolean;
}

function isKeyScope(value: string): value is KeyScope {
  return (KEY_SCOPE_PRECEDENCE as readonly string[]).includes(value);
}

/**
 * The scopes and surfaces live for whatever has focus, innermost first, plus
 * `global` — unless a `dialog` scope is in the chain, in which case the
 * global verbs are deliberately not live.
 */
export function resolveKeyContext(
  focused: ScopeChainNode | null | undefined,
): DispatchContext {
  const scopes: KeyScope[] = [];
  const surfaces: string[] = [];
  let node = focused ?? null;
  while (node) {
    const declared = node.scope ?? null;
    if (declared !== null && declared !== "") {
      const [scope, surface] = declared.split(":");
      if (scope !== undefined && isKeyScope(scope) && !scopes.includes(scope)) {
        scopes.push(scope);
      }
      if (
        surface !== undefined &&
        surface !== "" &&
        !surfaces.includes(surface)
      ) {
        surfaces.push(surface);
      }
    }
    node = node.parent ?? null;
  }
  if (!scopes.includes("dialog")) scopes.push("global");
  return { scopes, surfaces, inTextEntry: focused?.textEntry === true };
}

/** Reads a real DOM element as a `ScopeChainNode` chain (browser side). */
export function scopeChainFromElement(
  element: Element | null,
): ScopeChainNode | null {
  if (!element) return null;
  const parent = element.parentElement;
  const html = element as HTMLElement;
  const tag = element.tagName;
  return {
    scope: element.getAttribute(KEY_SCOPE_ATTRIBUTE),
    textEntry:
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      html.isContentEditable === true,
    parent: parent ? scopeChainFromElement(parent) : null,
  };
}
