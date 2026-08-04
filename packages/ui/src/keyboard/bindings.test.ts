import { describe, expect, it, vi } from "vitest";

import type {
  DispatchedKeyBinding,
  DocumentedKeyBinding,
  KeyEventLike,
} from "./bindings.js";
import {
  bindingKeysLabel,
  createKeyBindingRegistry,
  eventMatchesChord,
  formatChord,
  groupBindingsByScope,
  matchBinding,
  sortBindingsForOverlay,
} from "./bindings.js";

function dispatched(
  overrides: Partial<DispatchedKeyBinding> = {},
): DispatchedKeyBinding {
  return {
    kind: "dispatched",
    id: "verb-run",
    chords: [{ key: "r" }],
    label: "run the selected node",
    description: "runs the selected command node",
    scope: "global",
    run: () => {},
    ...overrides,
  };
}

function documented(
  overrides: Partial<DocumentedKeyBinding> = {},
): DocumentedKeyBinding {
  return {
    kind: "documented",
    id: "canvas-delete",
    chords: [{ key: "Backspace" }],
    label: "delete the selection",
    description: "deletes the selected nodes and edges",
    scope: "canvas",
    implementedBy: "xyflow",
    ...overrides,
  };
}

function event(
  overrides: Partial<KeyEventLike> & { key: string },
): KeyEventLike {
  return { preventDefault: () => {}, ...overrides };
}

describe("eventMatchesChord", () => {
  it("matches a letter case-insensitively", () => {
    expect(eventMatchesChord(event({ key: "R" }), { key: "r" })).toBe(true);
  });

  it("refuses a modified press for an unmodified chord — Cmd+J belongs to the browser", () => {
    expect(
      eventMatchesChord(event({ key: "j", metaKey: true }), { key: "j" }),
    ).toBe(false);
    expect(
      eventMatchesChord(event({ key: "j", ctrlKey: true }), { key: "j" }),
    ).toBe(false);
  });

  it("treats meta and ctrl as the same `mod`, so one chord covers both platforms", () => {
    const chord = { key: "k", mod: true };
    expect(eventMatchesChord(event({ key: "k", metaKey: true }), chord)).toBe(
      true,
    );
    expect(eventMatchesChord(event({ key: "k", ctrlKey: true }), chord)).toBe(
      true,
    );
    expect(eventMatchesChord(event({ key: "k" }), chord)).toBe(false);
  });

  it("ignores shift unless the chord states it — `?` needs shift on some layouts and not others", () => {
    expect(
      eventMatchesChord(event({ key: "?", shiftKey: true }), { key: "?" }),
    ).toBe(true);
    expect(eventMatchesChord(event({ key: "?" }), { key: "?" })).toBe(true);
    expect(
      eventMatchesChord(event({ key: "z", shiftKey: false }), {
        key: "z",
        mod: true,
        shift: true,
      }),
    ).toBe(false);
  });

  it("refuses an alt press for a chord that says nothing about alt", () => {
    expect(
      eventMatchesChord(event({ key: "r", altKey: true }), { key: "r" }),
    ).toBe(false);
    expect(
      eventMatchesChord(event({ key: "ArrowUp", altKey: true }), {
        key: "ArrowUp",
        alt: true,
      }),
    ).toBe(true);
  });
});

describe("matchBinding", () => {
  it("prefers the innermost scope — a dialog's Escape beats a global one", () => {
    const bindings = [
      dispatched({ id: "global-escape", chords: [{ key: "Escape" }] }),
      dispatched({
        id: "dialog-escape",
        chords: [{ key: "Escape" }],
        scope: "dialog",
      }),
    ];
    const match = matchBinding(bindings, event({ key: "Escape" }), {
      scopes: ["dialog"],
      inTextEntry: false,
    });
    expect(match?.binding.id).toBe("dialog-escape");
  });

  it("does not match a scope that is not active", () => {
    const match = matchBinding(
      [
        dispatched({
          id: "queue-next",
          chords: [{ key: "j" }],
          scope: "queue",
        }),
      ],
      event({ key: "j" }),
      { scopes: ["canvas", "global"], inTextEntry: false },
    );
    expect(match).toBeNull();
  });

  it("suppresses a letter binding while a text field has focus", () => {
    const bindings = [dispatched()];
    expect(
      matchBinding(bindings, event({ key: "r" }), {
        scopes: ["global"],
        inTextEntry: true,
      }),
    ).toBeNull();
  });

  it("lets an opted-in binding through a text field — the palette toggle means the same everywhere", () => {
    const match = matchBinding(
      [
        dispatched({
          id: "open-palette",
          chords: [{ key: "k", mod: true }],
          allowInTextEntry: true,
        }),
      ],
      event({ key: "k", metaKey: true }),
      { scopes: ["global"], inTextEntry: true },
    );
    expect(match?.binding.id).toBe("open-palette");
  });

  it("reports which chord matched, so a 1–9 binding can read the digit", () => {
    const match = matchBinding(
      [
        dispatched({
          id: "answer-nth",
          chords: [{ key: "1" }, { key: "2" }, { key: "3" }],
        }),
      ],
      event({ key: "2" }),
      { scopes: ["global"], inTextEntry: false },
    );
    expect(match?.chord.key).toBe("2");
  });
});

describe("createKeyBindingRegistry", () => {
  it("dispatches a registered binding and prevents the default", () => {
    const registry = createKeyBindingRegistry();
    const run = vi.fn();
    const preventDefault = vi.fn();
    registry.register(dispatched({ run }));
    const ran = registry.dispatch(event({ key: "r", preventDefault }), {
      scopes: ["global"],
      inTextEntry: false,
    });
    expect(ran?.id).toBe("verb-run");
    expect(run).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("leaves a documented binding to whoever implements it, and never claims the event", () => {
    const registry = createKeyBindingRegistry();
    const preventDefault = vi.fn();
    registry.register(documented());
    const ran = registry.dispatch(event({ key: "Backspace", preventDefault }), {
      scopes: ["canvas", "global"],
      inTextEntry: false,
    });
    expect(ran).toBeNull();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("still lists a documented binding — 'every binding appears in the overlay' includes xyflow's", () => {
    const registry = createKeyBindingRegistry();
    registry.register(documented());
    expect(registry.list().map((binding) => binding.id)).toEqual([
      "canvas-delete",
    ]);
  });

  it("refuses a duplicate id rather than silently replacing what the overlay lists", () => {
    const registry = createKeyBindingRegistry();
    registry.register(dispatched());
    expect(() => registry.register(dispatched())).toThrow(/already registered/);
  });

  it("refuses a chord already taken in the same scope — a shadowed binding would be listed while doing nothing", () => {
    const registry = createKeyBindingRegistry();
    registry.register(dispatched());
    expect(() =>
      registry.register(
        dispatched({ id: "verb-other", chords: [{ key: "r" }] }),
      ),
    ).toThrow(/would shadow "verb-run"/);
  });

  it("allows the same chord in a different scope — that is what scopes are for", () => {
    const registry = createKeyBindingRegistry();
    registry.register(dispatched());
    expect(() =>
      registry.register(
        dispatched({ id: "queue-run", chords: [{ key: "r" }], scope: "queue" }),
      ),
    ).not.toThrow();
  });

  it("allows two surfaces in one scope to bind the same key — every dialog wants Escape", () => {
    const registry = createKeyBindingRegistry();
    registry.register(
      dispatched({
        id: "palette-close",
        chords: [{ key: "Escape" }],
        scope: "dialog",
        surface: "command-palette",
      }),
    );
    expect(() =>
      registry.register(
        dispatched({
          id: "overlay-close",
          chords: [{ key: "Escape" }],
          scope: "dialog",
          surface: "shortcuts-overlay",
        }),
      ),
    ).not.toThrow();
    expect(registry.list()).toHaveLength(2);
  });

  it("still refuses a clash inside one surface", () => {
    const registry = createKeyBindingRegistry();
    registry.register(
      dispatched({
        id: "palette-close",
        chords: [{ key: "Escape" }],
        scope: "dialog",
        surface: "command-palette",
      }),
    );
    expect(() =>
      registry.register(
        dispatched({
          id: "palette-cancel",
          chords: [{ key: "Escape" }],
          scope: "dialog",
          surface: "command-palette",
        }),
      ),
    ).toThrow(/would shadow "palette-close"/);
  });

  it("dispatches only the focused surface's binding, though both are registered and both are listed", () => {
    const registry = createKeyBindingRegistry();
    const palette = vi.fn();
    const overlay = vi.fn();
    registry.register(
      dispatched({
        id: "palette-close",
        chords: [{ key: "Escape" }],
        scope: "dialog",
        surface: "command-palette",
        allowInTextEntry: true,
        run: palette,
      }),
    );
    registry.register(
      dispatched({
        id: "overlay-close",
        chords: [{ key: "Escape" }],
        scope: "dialog",
        surface: "shortcuts-overlay",
        run: overlay,
      }),
    );
    registry.dispatch(event({ key: "Escape" }), {
      scopes: ["dialog"],
      surfaces: ["shortcuts-overlay"],
      inTextEntry: false,
    });
    expect(overlay).toHaveBeenCalledOnce();
    expect(palette).not.toHaveBeenCalled();
  });

  it("unregisters exactly its own binding, so an unmounted surface stops dispatching", () => {
    const registry = createKeyBindingRegistry();
    const unregister = registry.register(dispatched());
    unregister();
    expect(registry.list()).toEqual([]);
    expect(
      registry.dispatch(event({ key: "r" }), {
        scopes: ["global"],
        inTextEntry: false,
      }),
    ).toBeNull();
  });

  it("can only ever dispatch something it also lists — the whole structural rule (§11)", () => {
    const registry = createKeyBindingRegistry();
    registry.register(dispatched({ id: "listed", chords: [{ key: "r" }] }));
    // A key nobody registered does nothing at all: there is no other path
    // from a keypress to an action, so "undocumented" is unreachable rather
    // than merely discouraged.
    expect(
      registry.dispatch(event({ key: "q" }), {
        scopes: ["global"],
        inTextEntry: false,
      }),
    ).toBeNull();
    const ran = registry.dispatch(event({ key: "r" }), {
      scopes: ["global"],
      inTextEntry: false,
    });
    expect(ran).not.toBeNull();
    expect(registry.list()).toContain(ran);
  });

  it("notifies subscribers on register and unregister, so the overlay cannot go stale", () => {
    const registry = createKeyBindingRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    const unregister = registry.register(dispatched());
    unregister();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("overlay rendering helpers", () => {
  it("sorts by scope precedence, then label, so mount order never reorders the overlay", () => {
    const sorted = sortBindingsForOverlay([
      dispatched({ id: "b", label: "zebra", scope: "global" }),
      dispatched({ id: "a", label: "apple", scope: "global" }),
      dispatched({ id: "c", label: "middle", scope: "dialog" }),
    ]);
    expect(sorted.map((binding) => binding.id)).toEqual(["c", "a", "b"]);
  });

  it("groups only the scopes that have bindings", () => {
    const groups = groupBindingsByScope([
      dispatched({ id: "a", chords: [{ key: "a" }] }),
      documented({ id: "b" }),
    ]);
    expect(groups.map((group) => group.scope)).toEqual(["canvas", "global"]);
  });

  it("formats a chord per platform without deciding anything visual", () => {
    expect(formatChord({ key: "k", mod: true }, true)).toBe("⌘K");
    expect(formatChord({ key: "k", mod: true }, false)).toBe("Ctrl+K");
    expect(formatChord({ key: "Escape" }, false)).toBe("Escape");
  });

  it("prefers an explicit keysLabel so nine chords read as a range", () => {
    expect(
      bindingKeysLabel(
        dispatched({
          chords: [{ key: "1" }, { key: "2" }],
          keysLabel: "1–9",
        }),
        false,
      ),
    ).toBe("1–9");
    expect(
      bindingKeysLabel(
        dispatched({ chords: [{ key: "j" }, { key: "k" }] }),
        false,
      ),
    ).toBe("J / K");
  });
});
