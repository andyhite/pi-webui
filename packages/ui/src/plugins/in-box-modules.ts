/**
 * The static registry of in-box contribution modules (§10.1's "distribution:
 * in the box" leg). v1 has no dynamic remote loading — recorded as deferred
 * in `docs/plugin-contract-draft.md`'s "known gaps" and again here: the
 * draft contract supports a plugin shipped from a directory or a configured
 * source, but nothing in this renderer loads one yet. In-box plugins compile
 * into the app instead, as a plain list of `{ pluginId, manifest }` pairs
 * registered through `ContributionRegistry.registerManifest` — the *same*
 * call a dynamically-loaded third-party plugin's manifest would go through
 * once that loader exists, so porting from this list to a loaded one is
 * additive, not a rewrite.
 *
 * Empty for Batch 5 Stage 1. Filesystem is Track B's own Stage 2 (this
 * batch, once Track C's frozen host and Track A's integration substrate
 * land); GitHub, Jira, and Coding/git are Track C's Epic 7.3 port. Nothing
 * is ported onto the draft contract yet, so this list has nothing to carry —
 * the seam exists and is exercised by `contribution-registry.test.ts`'s
 * fixture manifests, which is what proves it works before there is a real
 * plugin to add to it.
 */

import type { draft } from "@plotroom/plugin-sdk";

import {
  createContributionRegistry,
  type ContributionRegistry,
} from "./contribution-registry.js";

export interface InBoxPluginModule {
  readonly pluginId: string;
  readonly manifest: draft.DraftPluginManifest;
}

export const IN_BOX_PLUGIN_MODULES: readonly InBoxPluginModule[] = [];

/** A fresh registry, seeded with every in-box module above. */
export function createInBoxContributionRegistry(): ContributionRegistry {
  const registry = createContributionRegistry();
  for (const module of IN_BOX_PLUGIN_MODULES) {
    registry.registerManifest(module.pluginId, module.manifest);
  }
  return registry;
}
