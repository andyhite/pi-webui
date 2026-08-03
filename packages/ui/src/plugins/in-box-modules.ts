/**
 * The static registry of in-box contribution modules (§10.1's "distribution:
 * in the box" leg). v1 has no dynamic remote loading — recorded as deferred
 * in `docs/plugin-contract.md`'s §5 ("from a source the user configures" is
 * deferred) and again here: the frozen contract supports a plugin shipped
 * from a directory or a configured source, but nothing in this renderer
 * loads one yet. In-box plugins compile into the app instead, as a plain
 * list of `{ pluginId, manifest }` pairs registered through
 * `ContributionRegistry.registerManifest` — the *same* call a
 * dynamically-loaded third-party plugin's manifest would go through once
 * that loader exists, so porting from this list to a loaded one is
 * additive, not a rewrite.
 *
 * **Filesystem** (`@plotroom/plugin-filesystem`, Track B's Stage 2) is the
 * first real entry: files and directories as `document` concepts, browse
 * via `read` with `externalId: null`, drag via the registered card renderer
 * (§9.4). GitHub, Jira, and Coding/git are Track C's Epic 7.3 port and land
 * here the same way once they do. This module's card/content/palette
 * contributions are registered client-side today; the producer itself has
 * no live caller yet — **server-side registration of a real worker-hosted
 * producer is Track A's**: nothing under `apps/server/src/integrations/` is
 * wired to `PluginHost`/`PluginRegistry` (`@plotroom/plugin-sdk`) yet, so
 * there is no `/api` seam that actually invokes this plugin's `read` in the
 * running app (see `packages/plugins/filesystem`'s own doc comments and
 * `docs/development-plan.md`'s Epic 7.3 landed-note for what that wiring
 * needs).
 */

import type { PluginManifest } from "@plotroom/plugin-sdk";
import filesystemManifest from "@plotroom/plugin-filesystem";

import {
  createContributionRegistry,
  type ContributionRegistry,
} from "./contribution-registry.js";

export interface InBoxPluginModule {
  readonly pluginId: string;
  readonly manifest: PluginManifest;
}

export const IN_BOX_PLUGIN_MODULES: readonly InBoxPluginModule[] = [
  { pluginId: filesystemManifest.id, manifest: filesystemManifest },
];

/** A fresh registry, seeded with every in-box module above. */
export function createInBoxContributionRegistry(): ContributionRegistry {
  const registry = createContributionRegistry();
  for (const module of IN_BOX_PLUGIN_MODULES) {
    registry.registerManifest(module.pluginId, module.manifest);
  }
  return registry;
}
