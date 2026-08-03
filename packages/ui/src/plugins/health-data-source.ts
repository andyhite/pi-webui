/**
 * The plugin health panel's data (§10.2, §11's dock rail). Mirrors every
 * other panel data source's `load`/`subscribe` shape (`fleet/types.ts`,
 * `data-source/types.ts`): a one-shot read plus live updates, so swapping
 * the fixture for a real one later (once the server publishes lifecycle
 * events to the renderer) touches nothing that consumes
 * `PluginHealthDataSource`.
 *
 * Fixture-fed until the server wires `@plotroom/plugin-sdk`'s host up.
 * `PluginHost`/`PluginRegistry` are real now — contract v1 is frozen
 * (`docs/plugin-contract.md`), with load/invoke, enable/disable/remove, and
 * a `PluginRegistryEvent` stream — but `apps/server` mounts none of it yet:
 * there is no `/api/plugins` and nothing publishes `type: "plugin"` events
 * on the WS stream (§8's "wiring contract for the server" is Track A's).
 * `createFixturePluginHealthDataSource` is the fixture until that lands.
 */

import type { Unsubscribe } from "../data-source/types.js";
import type { PluginHealthEntry } from "./types.js";

export interface PluginHealthDataSource {
  load(): Promise<readonly PluginHealthEntry[]>;
  subscribe(
    onEntries: (entries: readonly PluginHealthEntry[]) => void,
  ): Unsubscribe;
}

/** Fixtures never change; `subscribe` never fires (same posture as `createFixtureGraphDataSource`). */
export function createFixturePluginHealthDataSource(
  entries: readonly PluginHealthEntry[],
): PluginHealthDataSource {
  return {
    load(): Promise<readonly PluginHealthEntry[]> {
      return Promise.resolve(entries);
    },
    subscribe(): Unsubscribe {
      return () => {};
    },
  };
}

/**
 * The honest live stand-in: the server has no `/api/plugins` and no
 * lifecycle event stream yet (see this file's own doc comment), so there is
 * nothing real to report — the gap is the server's wiring, not the host or
 * registry the SDK now ships. Resolves zero entries rather than
 * manufacturing fixture rows — `types.ts`'s own words are "an honest
 * absence, not a manufactured 'connected'" — and the panel's own empty
 * state ("no plugins installed") renders for it. `subscribe` never fires,
 * for the same reason the fixture source's never does: there is no live
 * event source behind it yet.
 */
export function createEmptyPluginHealthDataSource(): PluginHealthDataSource {
  return {
    load(): Promise<readonly PluginHealthEntry[]> {
      return Promise.resolve([]);
    },
    subscribe(): Unsubscribe {
      return () => {};
    },
  };
}
