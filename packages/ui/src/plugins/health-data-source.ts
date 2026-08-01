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
