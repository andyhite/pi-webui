/**
 * The panel registry (spec §11): "a dock rail with a panel registry — panels
 * registered, including by plugins; one open at a time; closing is cheap
 * because state persists."
 *
 * A registry, not a hardcoded list — plugins register their own panels later
 * (§10.1) through the exact same `register` call the in-box panels use.
 *
 * State is generic per panel (`TState`) but stored heterogeneously, so the
 * registry itself only stores an initial value and a renderer; ownership of
 * *where* the live state lives (so it survives a close/reopen) is
 * `DockRail`'s job, not the registry's — see panels/DockRail.tsx.
 */

import type { ReactNode } from "react";

export interface PanelRenderProps<TState> {
  readonly state: TState;
  readonly setState: (next: TState) => void;
}

/** What the registry actually stores: state-erased, so panels can coexist. */
export interface PanelDefinition {
  readonly id: string;
  readonly title: string;
  readonly initialState: unknown;
  readonly render: (props: PanelRenderProps<unknown>) => ReactNode;
}

/** The typed shape a caller declares a panel with; erased on `register`. */
export interface PanelSpec<TState> {
  readonly id: string;
  readonly title: string;
  readonly initialState: TState;
  readonly render: (props: PanelRenderProps<TState>) => ReactNode;
}

/** Declares a panel with its real state type, for a nicer call site. */
export function definePanel<TState>(spec: PanelSpec<TState>): PanelDefinition {
  return spec as PanelDefinition;
}

export interface PanelRegistry {
  register(panel: PanelDefinition): void;
  unregister(id: string): void;
  list(): readonly PanelDefinition[];
  get(id: string): PanelDefinition | undefined;
}

export function createPanelRegistry(
  initial: readonly PanelDefinition[] = [],
): PanelRegistry {
  const panels = new Map<string, PanelDefinition>();
  for (const panel of initial) panels.set(panel.id, panel);

  return {
    register(panel) {
      panels.set(panel.id, panel);
    },
    unregister(id) {
      panels.delete(id);
    },
    list() {
      return [...panels.values()];
    },
    get(id) {
      return panels.get(id);
    },
  };
}

/**
 * "One open at a time": clicking the open panel's own dock icon closes it;
 * clicking a different one switches to it. Pure so the toggle rule is
 * testable without mounting anything.
 */
export function nextOpenPanelId(
  current: string | null,
  clicked: string,
): string | null {
  return current === clicked ? null : clicked;
}

/** A per-panel state bag, keyed by panel id — the thing that must outlive a close. */
export type PanelStateBag = Readonly<Record<string, unknown>>;

export function withPanelState(
  bag: PanelStateBag,
  id: string,
  state: unknown,
): PanelStateBag {
  return { ...bag, [id]: state };
}
