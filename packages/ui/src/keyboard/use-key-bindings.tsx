/**
 * The registry's React half (§11): a provider, a `useKeyBindings` that
 * registers on mount and unregisters on unmount, and **one** window-level
 * keydown listener for the whole app.
 *
 * One listener is the point. Before this, components each added their own
 * `window.addEventListener("keydown", …)` (the palette's toggle, the canvas's
 * undo) and nothing listed them anywhere — exactly the "hardcoded overlay
 * list beside a hardcoded handler" drift §11 forbids. Now the only way a key
 * does anything is a registered binding, and the overlay renders whatever is
 * registered.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type {
  KeyBinding,
  KeyBindingRegistry,
  KeyEventLike,
} from "./bindings.js";
import { createKeyBindingRegistry } from "./bindings.js";
import { activeScopes, scopeChainFromElement } from "./scope.js";

/**
 * A process-wide fallback registry, so a component that registers bindings
 * (the canvas, the palette) still works when mounted without a provider — a
 * test harness, a one-off page. The app wraps itself in
 * `KeyBindingsProvider`, which is what makes the overlay and the dispatcher
 * see the same set.
 */
const fallbackRegistry = createKeyBindingRegistry();

const KeyBindingsContext = createContext<KeyBindingRegistry>(fallbackRegistry);

export interface KeyBindingsProviderProps {
  readonly registry?: KeyBindingRegistry;
  readonly children: React.ReactNode;
}

export function KeyBindingsProvider({
  registry,
  children,
}: KeyBindingsProviderProps) {
  // One registry per provider instance unless the host supplies its own.
  const owned = useMemo(
    () => registry ?? createKeyBindingRegistry(),
    [registry],
  );
  return (
    <KeyBindingsContext.Provider value={owned}>
      {children}
    </KeyBindingsContext.Provider>
  );
}

export function useKeyBindingRegistry(): KeyBindingRegistry {
  return useContext(KeyBindingsContext);
}

/**
 * Registers bindings for as long as the component is mounted. `bindings` is
 * re-registered whenever it changes identity, so a closure over fresh state
 * (the selected node, the queue's cursor) stays current — memoize it in the
 * caller if that is more churn than wanted.
 */
export function useKeyBindings(bindings: readonly KeyBinding[]): void {
  const registry = useKeyBindingRegistry();
  useEffect(() => {
    const unregister = bindings.map((binding) => registry.register(binding));
    return () => {
      for (const undo of unregister) undo();
    };
  }, [registry, bindings]);
}

/** Everything currently registered, live — the overlay's only data source. */
export function useRegisteredBindings(): readonly KeyBinding[] {
  const registry = useKeyBindingRegistry();
  const [bindings, setBindings] = useState<readonly KeyBinding[]>(() =>
    registry.list(),
  );
  useEffect(() => {
    setBindings(registry.list());
    return registry.subscribe(() => setBindings(registry.list()));
  }, [registry]);
  return bindings;
}

/**
 * Installs the app's single keydown listener. Scope comes from what has
 * focus (`scope.ts`), so a key means what the focused surface says it means
 * and nothing has to be enabled or disabled by hand.
 */
export function useKeyBindingDispatch(): void {
  const registry = useKeyBindingRegistry();
  const registryRef = useRef(registry);
  registryRef.current = registry;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target =
        event.target instanceof Element ? event.target : document.body;
      const chain = scopeChainFromElement(target);
      registryRef.current.dispatch(event as KeyEventLike, {
        scopes: activeScopes(chain),
        inTextEntry: chain?.textEntry === true,
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
