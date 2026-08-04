import { describe, expect, it, vi } from "vitest";

import type { AppVerb } from "./verbs.js";
import {
  bindingFromVerb,
  bindingsFromVerbs,
  commandPaletteItemsFromVerbs,
  runAppVerb,
} from "./verbs.js";

function verb(overrides: Partial<AppVerb> = {}): AppVerb {
  return {
    id: "verb-run-selected-node",
    label: "run the selected node",
    description: "runs the selected command node",
    run: () => {},
    chords: [{ key: "r" }],
    ...overrides,
  };
}

describe("bindingFromVerb", () => {
  it("carries the verb's own id, label and description into the binding the overlay renders", () => {
    const binding = bindingFromVerb(verb());
    expect(binding).toMatchObject({
      id: "verb-run-selected-node",
      label: "run the selected node",
      description: "runs the selected command node",
      scope: "global",
    });
  });

  it("returns null for a palette-only verb rather than inventing a chord for it", () => {
    expect(bindingFromVerb(verb({ chords: [] }))).toBeNull();
    const { chords: _chords, ...withoutChords } = verb();
    expect(bindingFromVerb(withoutChords)).toBeNull();
  });

  it("runs the verb's own action, passing the matched chord through", () => {
    const run = vi.fn();
    const binding = bindingFromVerb(verb({ run }));
    binding?.run({ key: "2" }, { key: "2" });
    expect(run).toHaveBeenCalledWith({ key: "2" });
  });
});

describe("bindingsFromVerbs", () => {
  it("keeps only the verbs that have chords", () => {
    const bindings = bindingsFromVerbs([
      verb({ id: "a" }),
      verb({ id: "b", chords: [] }),
    ]);
    expect(bindings.map((binding) => binding.id)).toEqual(["a"]);
  });
});

describe("commandPaletteItemsFromVerbs", () => {
  it("gives every verb a palette row under the same id the binding uses", () => {
    const verbs = [verb({ id: "a" }), verb({ id: "b", chords: [] })];
    const items = commandPaletteItemsFromVerbs(verbs);
    expect(items).toEqual([
      { id: "a", label: "run the selected node", kind: "verb" },
      { id: "b", label: "run the selected node", kind: "verb" },
    ]);
  });

  it("shows a verb's binding beside it when the host resolves one", () => {
    const items = commandPaletteItemsFromVerbs([verb()], () => "R");
    expect(items[0]?.keys).toBe("R");
  });

  it("keeps palette rows and bindings on one vocabulary — every binding id is a palette id", () => {
    const verbs = [
      verb({ id: "a" }),
      verb({ id: "b", chords: [{ key: "b" }] }),
    ];
    const paletteIds = commandPaletteItemsFromVerbs(verbs).map(
      (item) => item.id,
    );
    for (const binding of bindingsFromVerbs(verbs)) {
      expect(paletteIds).toContain(binding.id);
    }
  });
});

describe("runAppVerb", () => {
  it("runs the named verb and reports that it did", () => {
    const run = vi.fn();
    expect(runAppVerb([verb({ run })], "verb-run-selected-node")).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it("reports false for an id no verb owns, so a host can fall through to plugin entries", () => {
    expect(runAppVerb([verb()], "plugin:something")).toBe(false);
  });
});
