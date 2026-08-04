/**
 * One verb definition, two surfaces (§11): "a command palette — one keyboard
 * entry point for navigation and every verb" and "keyboard access to the
 * high-frequency verbs". A verb is declared once here and becomes both a
 * palette row and (when it has chords) a registry binding, so the palette
 * and the keyboard cannot drift into meaning different things by the same
 * name — the same reason the registry is the overlay's only data source
 * (principle 8, one vocabulary).
 *
 * A verb's `run` is always the host's existing action — the very function the
 * mouse path calls. Nothing here is a second implementation of a gesture.
 */

import type { CommandPaletteItem } from "../command-palette/model.js";
import type { DispatchedKeyBinding, KeyChord, KeyScope } from "./bindings.js";

export interface AppVerb {
  /** Stable id, shared by the palette row and the binding. */
  readonly id: string;
  /** How both surfaces name it ("run the selected node"). */
  readonly label: string;
  /** One sentence for the overlay: what it does, and to what. */
  readonly description: string;
  /** The host's existing action. `chord` is passed for `1`–`9`-style verbs. */
  readonly run: (chord?: KeyChord) => void;
  /** Omitted: palette-only, which is the honest home for a rare verb. */
  readonly chords?: readonly KeyChord[];
  /** Overlay label for a range of chords ("1–9"). */
  readonly keysLabel?: string;
  /** Defaults to `global`. */
  readonly scope?: KeyScope;
  /** Which surface inside that scope, when it holds more than one. */
  readonly surface?: string;
  readonly allowInTextEntry?: boolean;
}

/** The binding a verb backs, or `null` for a palette-only verb. */
export function bindingFromVerb(verb: AppVerb): DispatchedKeyBinding | null {
  if (!verb.chords || verb.chords.length === 0) return null;
  return {
    kind: "dispatched",
    id: verb.id,
    chords: verb.chords,
    ...(verb.keysLabel === undefined ? {} : { keysLabel: verb.keysLabel }),
    label: verb.label,
    description: verb.description,
    scope: verb.scope ?? "global",
    ...(verb.surface === undefined ? {} : { surface: verb.surface }),
    ...(verb.allowInTextEntry === undefined
      ? {}
      : { allowInTextEntry: verb.allowInTextEntry }),
    run: (_event, chord) => verb.run(chord),
  };
}

export function bindingsFromVerbs(
  verbs: readonly AppVerb[],
): readonly DispatchedKeyBinding[] {
  return verbs
    .map(bindingFromVerb)
    .filter((binding): binding is DispatchedKeyBinding => binding !== null);
}

/**
 * The same verbs as palette rows — id, label and all — so a verb reachable
 * by keyboard is reachable by palette and vice versa. `keysLabel` rides
 * along so the palette can show a verb's own binding beside it.
 */
export function commandPaletteItemsFromVerbs(
  verbs: readonly AppVerb[],
  keysLabelFor: (verb: AppVerb) => string | undefined = () => undefined,
): readonly CommandPaletteItem[] {
  return verbs.map((verb) => {
    const keys = keysLabelFor(verb);
    return {
      id: verb.id,
      label: verb.label,
      kind: "verb" as const,
      ...(keys === undefined ? {} : { keys }),
    };
  });
}

/**
 * Runs the verb the palette activated, by id. Returns false when no verb
 * owns that id, so a host can fall through to its plugin-contributed
 * entries rather than swallowing an unknown row.
 */
export function runAppVerb(verbs: readonly AppVerb[], id: string): boolean {
  const verb = verbs.find((candidate) => candidate.id === id);
  if (!verb) return false;
  verb.run();
  return true;
}
