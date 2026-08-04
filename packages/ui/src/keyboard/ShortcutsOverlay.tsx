/**
 * The shortcuts overlay (§11: "every binding appears in a shortcuts overlay —
 * a binding cannot exist undocumented"). It renders the registry, and only
 * the registry: there is no list in this file. A binding that dispatches is
 * registered, a registered binding is listed here, and a key that is not
 * registered does nothing — which is what makes "cannot exist undocumented"
 * a property of the code rather than a promise in a comment.
 *
 * The overlay is itself a dialog: it traps focus, restores it on close, and
 * declares `data-key-scope="dialog"` so the global verbs behind it do not
 * fire while it is open. Its own toggle is a registered binding too (the
 * host registers it — `App.tsx`), listed here like anything else.
 *
 * Unstyled: mechanics only until the design package lands (fleet rule 5).
 */

import { useMemo, useRef } from "react";

import type { KeyBinding, KeyScope } from "./bindings.js";
import { bindingKeysLabel, groupBindingsByScope } from "./bindings.js";
import { useFocusTrap } from "./use-focus-trap.js";
import { useKeyBindings, useRegisteredBindings } from "./use-key-bindings.js";

const SCOPE_TITLES: Record<KeyScope, string> = {
  dialog: "in a dialog",
  queue: "in the attention queue",
  list: "in a list",
  canvas: "on the canvas",
  global: "anywhere",
};

export interface ShortcutsOverlayProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function ShortcutsOverlay({ open, onClose }: ShortcutsOverlayProps) {
  const bindings = useRegisteredBindings();
  const containerRef = useFocusTrap<HTMLDivElement>(open);

  // Its own dismissal is a registered binding — so the overlay lists the key
  // that closes it, which is the smallest possible test of the rule it exists
  // to enforce. Registered whether or not it is open: the binding is scoped to
  // this dialog's surface, so it can only fire while focus is inside it.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const closeBindings = useMemo<readonly KeyBinding[]>(
    () => [
      {
        kind: "dispatched",
        id: "shortcuts-overlay-close",
        chords: [{ key: "Escape" }, { key: "?" }],
        label: "close the shortcuts overlay",
        description: "closes this list and returns focus where it was",
        scope: "dialog",
        surface: "shortcuts-overlay",
        run: () => closeRef.current(),
      },
    ],
    [],
  );
  useKeyBindings(closeBindings);

  if (!open) return null;

  const groups = groupBindingsByScope(bindings);

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label="keyboard shortcuts"
      data-key-scope="dialog:shortcuts-overlay"
      data-testid="shortcuts-overlay"
      tabIndex={-1}
    >
      <h2>keyboard shortcuts</h2>
      {groups.length === 0 ? <div>no bindings are registered</div> : null}
      {groups.map((group) => (
        <section key={group.scope} aria-label={SCOPE_TITLES[group.scope]}>
          <h3>{SCOPE_TITLES[group.scope]}</h3>
          <ul aria-label={`shortcuts ${SCOPE_TITLES[group.scope]}`}>
            {group.bindings.map((binding) => (
              <li key={binding.id} data-testid={`shortcut-${binding.id}`}>
                <kbd>{bindingKeysLabel(binding)}</kbd> {binding.label} —{" "}
                {binding.description}
                {binding.kind === "documented"
                  ? ` (handled by ${binding.implementedBy})`
                  : ""}
              </li>
            ))}
          </ul>
        </section>
      ))}
      <button type="button" onClick={onClose}>
        close
      </button>
    </div>
  );
}
