/**
 * The one keyboard binding registry (spec §11): "keyboard access to the
 * high-frequency verbs, not just navigation ... every binding appears in a
 * shortcuts overlay — a binding cannot exist undocumented."
 *
 * That last clause is a **structural** rule here, not a convention: this
 * registry is both the dispatcher and the overlay's data source. A key
 * reaches a handler only by being registered (`register`), registering
 * demands the fields the overlay renders (`label`, `description`), and the
 * overlay renders `list()` — so a hardcoded overlay list beside a hardcoded
 * handler, the failure mode §11 exists to prevent, has nowhere to live.
 *
 * Two kinds of binding, because some keys are genuinely implemented by the
 * library under us (xyflow's own Backspace delete, arrow-key node nudge,
 * Shift-marquee) and pretending otherwise would be worse than documenting
 * them honestly:
 *
 *   - `dispatched` — this registry runs it (`run`).
 *   - `documented` — something else implements it, named in `implementedBy`;
 *     `dispatch` never runs one, and the overlay lists it exactly like any
 *     other, so "every binding appears in the overlay" stays true for keys
 *     this codebase does not own the handler for.
 *
 * Pure: no React, no DOM. `dispatch` takes a `KeyEventLike`, so every rule
 * below is unit-testable without a browser.
 */

/**
 * Where a binding is live. Scope is resolved from what currently has focus
 * (`scope.ts`), and the vocabulary is closed on purpose: a surface that
 * wanted a scope of its own would be adding a place bindings can hide.
 *
 *   - `global` — anywhere in the app, with no modal open.
 *   - `canvas` — focus is inside the canvas (a node, the pane).
 *   - `queue` — focus is inside the attention queue's listbox.
 *   - `list` — focus is inside a keyboard-navigable list (palette rail,
 *     a command's ordered context inputs).
 *   - `dialog` — focus is inside a modal that traps it (command palette,
 *     shortcuts overlay, create menu, a stop confirmation).
 */
export type KeyScope = "global" | "canvas" | "queue" | "list" | "dialog";

/**
 * Scope precedence, innermost first: a `dialog` binding beats a `queue` one,
 * which beats `global`. Exported because `scope.ts` and the overlay both
 * order by it and must not each have their own idea of the order.
 */
export const KEY_SCOPE_PRECEDENCE: readonly KeyScope[] = [
  "dialog",
  "queue",
  "list",
  "canvas",
  "global",
];

/**
 * One key combination. `mod` is Cmd on macOS and Ctrl elsewhere — the one
 * platform difference the app has, kept here so no call site branches on
 * `navigator.platform` itself.
 *
 * `shift` and `alt` are compared only when set: a chord for `?` says nothing
 * about shift (typing `?` needs it on most layouts and not on others), while
 * `mod+shift+z` says both explicitly.
 */
export interface KeyChord {
  /** `KeyboardEvent.key`, compared case-insensitively. */
  readonly key: string;
  readonly mod?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

interface BindingBase {
  /** Stable id; also the command palette's item id when a verb backs it. */
  readonly id: string;
  /** Every chord that triggers it — `1`–`9` is one binding, nine chords. */
  readonly chords: readonly KeyChord[];
  /**
   * How the overlay names the keys. Defaults to the formatted chords; set it
   * when a range reads better than nine of them ("1–9").
   */
  readonly keysLabel?: string;
  /** The verb, as the overlay names it ("run the selected node"). */
  readonly label: string;
  /** One sentence: what pressing it does, and to what. */
  readonly description: string;
  readonly scope: KeyScope;
  /**
   * Which surface inside that scope, when the scope holds more than one:
   * every dialog wants Escape and every keyboard-navigable list wants the
   * arrows, and they must mean *that* surface's version. Declared in the DOM
   * as `data-key-scope="dialog:command-palette"` (`scope.ts`). Omitted: live
   * for every surface in the scope.
   */
  readonly surface?: string;
  /**
   * Live while a text field has focus. Off by default — a single-letter verb
   * binding must never eat a character being typed — and on for the few keys
   * that mean the same thing everywhere (Escape, the palette's own toggle,
   * anything in a dialog whose focus lives in its own input).
   */
  readonly allowInTextEntry?: boolean;
}

export interface DispatchedKeyBinding extends BindingBase {
  readonly kind: "dispatched";
  /** Runs on a match; the matched chord is passed so `1`–`9` can read the digit. */
  readonly run: (event: KeyEventLike, chord: KeyChord) => void;
  /** Defaults to true: a bound key is handled here, not by the browser too. */
  readonly preventDefault?: boolean;
}

export interface DocumentedKeyBinding extends BindingBase {
  readonly kind: "documented";
  /** Who actually implements it, e.g. `"xyflow"` — never dispatched here. */
  readonly implementedBy: string;
}

export type KeyBinding = DispatchedKeyBinding | DocumentedKeyBinding;

/** The parts of a `KeyboardEvent` dispatch needs — so tests need no DOM. */
export interface KeyEventLike {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  preventDefault?: () => void;
}

export interface DispatchContext {
  /** Active scopes, innermost first (`resolveKeyContext` in `scope.ts`). */
  readonly scopes: readonly KeyScope[];
  /** Active surface names, from the same `data-key-scope` declarations. */
  readonly surfaces?: readonly string[];
  /** True when focus is in an input/textarea/contenteditable. */
  readonly inTextEntry: boolean;
}

/** True when the platform is a Mac — the one place `mod` resolves. */
function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as { userAgentData?: { platform?: string } }).userAgentData
      ?.platform ?? navigator.platform;
  return /mac/i.test(platform ?? "");
}

/**
 * Keys whose `KeyboardEvent.key` is not readable as itself. The space bar's
 * key is a literal `" "`, which the overlay would otherwise print as a blank
 * — a binding rendered as nothing is an undocumented binding (§11).
 */
const KEY_DISPLAY_NAMES: Readonly<Record<string, string>> = { " ": "Space" };

/** Formats one chord for the overlay: `Mod+K` renders as `⌘K` / `Ctrl+K`. */
export function formatChord(chord: KeyChord, mac = isMacPlatform()): string {
  const parts: string[] = [];
  if (chord.mod) parts.push(mac ? "⌘" : "Ctrl");
  if (chord.alt) parts.push(mac ? "⌥" : "Alt");
  if (chord.shift) parts.push("Shift");
  const named = KEY_DISPLAY_NAMES[chord.key];
  parts.push(
    named ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key),
  );
  return parts.join(mac ? "" : "+") || chord.key;
}

/**
 * What the overlay shows for a binding: every chord that fires it, or the
 * binding's own `keysLabel`.
 *
 * A `keysLabel` is an **abbreviation of the whole chord list**, never a subset
 * of it — "1–9" for nine digits, "↓ / ↑" for two arrows. A label naming one of
 * two real chords would hide the other, which is the same failure as an
 * unlisted binding: the overlay would be telling the operator about less than
 * what the keyboard actually does.
 */
export function bindingKeysLabel(
  binding: KeyBinding,
  mac = isMacPlatform(),
): string {
  if (binding.keysLabel !== undefined) return binding.keysLabel;
  return binding.chords.map((chord) => formatChord(chord, mac)).join(" / ");
}

/**
 * Does this event press this chord? Modifier comparison is exact for `mod`
 * (a bare `j` must not fire on `Cmd+j`, which belongs to the browser) and
 * opt-in for `shift`/`alt`, since a printable key like `?` or `/` carries no
 * portable claim about shift.
 */
export function eventMatchesChord(
  event: KeyEventLike,
  chord: KeyChord,
): boolean {
  if (event.key.toLowerCase() !== chord.key.toLowerCase()) return false;
  const mod = Boolean(event.metaKey) || Boolean(event.ctrlKey);
  if (mod !== Boolean(chord.mod)) return false;
  if (chord.shift !== undefined && Boolean(event.shiftKey) !== chord.shift) {
    return false;
  }
  if (chord.alt !== undefined && Boolean(event.altKey) !== chord.alt) {
    return false;
  }
  if (chord.alt === undefined && event.altKey) return false;
  return true;
}

/**
 * The binding an event should run, given what has focus — or `null`. Ordered
 * by scope precedence, so the palette's Escape wins over anything global
 * while the palette is open.
 */
export function matchBinding(
  bindings: readonly KeyBinding[],
  event: KeyEventLike,
  context: DispatchContext,
): { readonly binding: KeyBinding; readonly chord: KeyChord } | null {
  const scopes = KEY_SCOPE_PRECEDENCE.filter((scope) =>
    context.scopes.includes(scope),
  );
  const surfaces = context.surfaces ?? [];
  for (const scope of scopes) {
    for (const binding of bindings) {
      if (binding.scope !== scope) continue;
      if (
        binding.surface !== undefined &&
        !surfaces.includes(binding.surface)
      ) {
        continue;
      }
      if (context.inTextEntry && binding.allowInTextEntry !== true) continue;
      const chord = binding.chords.find((candidate) =>
        eventMatchesChord(event, candidate),
      );
      if (chord) return { binding, chord };
    }
  }
  return null;
}

/**
 * Sorted for the overlay: by scope precedence, then by label, so the list is
 * stable regardless of the order components happened to mount in.
 */
export function sortBindingsForOverlay(
  bindings: readonly KeyBinding[],
): readonly KeyBinding[] {
  return bindings.slice().sort((a, b) => {
    const scopeDelta =
      KEY_SCOPE_PRECEDENCE.indexOf(a.scope) -
      KEY_SCOPE_PRECEDENCE.indexOf(b.scope);
    return scopeDelta !== 0 ? scopeDelta : a.label.localeCompare(b.label);
  });
}

/** Overlay grouping: one section per scope that has any binding at all. */
export function groupBindingsByScope(
  bindings: readonly KeyBinding[],
): readonly {
  readonly scope: KeyScope;
  readonly bindings: readonly KeyBinding[];
}[] {
  const sorted = sortBindingsForOverlay(bindings);
  return KEY_SCOPE_PRECEDENCE.map((scope) => ({
    scope,
    bindings: sorted.filter((binding) => binding.scope === scope),
  })).filter((group) => group.bindings.length > 0);
}

export interface KeyBindingRegistry {
  /**
   * Registers a binding and returns its own unregister. Refuses a duplicate
   * id, and refuses a chord already taken in the same scope: a silently
   * shadowed binding would be listed in the overlay while doing nothing,
   * which is the same lie as an undocumented one.
   */
  register(binding: KeyBinding): () => void;
  list(): readonly KeyBinding[];
  /** Fires whenever the set changes, so the overlay re-renders. */
  subscribe(listener: () => void): () => void;
  /**
   * Runs the matching binding, if any, and returns it. `documented`
   * bindings match nothing here — whoever `implementedBy` names handles
   * them — so the event is left alone.
   */
  dispatch(event: KeyEventLike, context: DispatchContext): KeyBinding | null;
}

export function createKeyBindingRegistry(): KeyBindingRegistry {
  const bindings = new Map<string, KeyBinding>();
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  return {
    register(binding) {
      const existing = bindings.get(binding.id);
      if (existing) {
        throw new Error(
          `keyboard binding "${binding.id}" is already registered`,
        );
      }
      for (const other of bindings.values()) {
        if (other.scope !== binding.scope) continue;
        // Two surfaces in one scope (two dialogs, two lists) legitimately
        // want the same key: only a clash *within* one surface shadows.
        if (other.surface !== binding.surface) continue;
        const clash = binding.chords.find((chord) =>
          other.chords.some(
            (candidate) =>
              candidate.key.toLowerCase() === chord.key.toLowerCase() &&
              Boolean(candidate.mod) === Boolean(chord.mod) &&
              Boolean(candidate.shift) === Boolean(chord.shift) &&
              Boolean(candidate.alt) === Boolean(chord.alt),
          ),
        );
        if (clash) {
          throw new Error(
            `keyboard binding "${binding.id}" would shadow "${other.id}" ` +
              `on ${formatChord(clash, false)} in scope ${binding.scope}`,
          );
        }
      }
      bindings.set(binding.id, binding);
      notify();
      return () => {
        if (bindings.get(binding.id) === binding) {
          bindings.delete(binding.id);
          notify();
        }
      };
    },
    list() {
      return sortBindingsForOverlay([...bindings.values()]);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch(event, context) {
      const match = matchBinding([...bindings.values()], event, context);
      if (!match) return null;
      if (match.binding.kind === "documented") return null;
      if (match.binding.preventDefault !== false) event.preventDefault?.();
      match.binding.run(event, match.chord);
      return match.binding;
    },
  };
}
