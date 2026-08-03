/**
 * The plugin health panel's data (§10.2, §11's dock rail). Mirrors every
 * other panel data source's `load`/`subscribe` shape (`fleet/types.ts`,
 * `data-source/types.ts`): a one-shot read plus live updates, so swapping
 * the fixture for a real one later (once the host's lifecycle events reach
 * the renderer) touches nothing that consumes `PluginHealthDataSource`.
 *
 * Fixture-fed until Epic 7.1's host lands its lifecycle events on `main`
 * (the worker_threads skeleton — load/ping/dispose — exists; enable/
 * disable/remove and a health event stream do not, per the draft's own
 * "known gaps"). `createFixturePluginHealthDataSource` is that fixture.
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
 * The honest live stand-in: the host has no enable/disable/remove verbs and
 * no lifecycle event stream yet (see this file's own doc comment and
 * `docs/plugin-contract-draft.md`'s "known gaps"), so there is nothing real
 * to report. Resolves zero entries rather than manufacturing fixture rows —
 * `types.ts`'s own words are "an honest absence, not a manufactured
 * 'connected'" — and the panel's own empty state ("no plugins installed")
 * renders for it. `subscribe` never fires, for the same reason the fixture
 * source's never does: there is no live event source behind it yet.
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
