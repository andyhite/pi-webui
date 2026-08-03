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
 * (§9.4). **Coding/git** (`@plotroom/plugin-git`) and **GitHub**
 * (`@plotroom/plugin-github`) are Track C's Epic 7.3 port and land here the
 * same way, this batch's final wave — the git plugin's `diff`/`commit` card
 * and content renderers, and GitHub's `pull_request`/`review`/`ticket`/
 * `document` card, content, and palette (clone-from-a-pull-request)
 * contributions. Both packages default-export the manifest their `index.ts`
 * builds with real, machine-touching dependencies (git's `node:child_process`
 * spawner, GitHub's `fetch` transport) — never `./testing`'s recorded stand-in,
 * which exists for that package's own tests. **Jira** (`@plotroom/plugin-jira`)
 * lands here the same way, Track C's Epic 7.3 port: tickets, epics-as-collections,
 * and workflow-as-document card, content, and palette (search-by-JQL)
 * contributions, its shipped `fetch`-backed transport rather than `./testing`'s
 * recorded stand-in. This module's card/content/palette
 * contributions are registered client-side today; the producers themselves have
 * no live caller yet — **server-side registration of a real worker-hosted
 * producer is Track A's**: nothing under `apps/server/src/integrations/` is
 * wired to `PluginHost`/`PluginRegistry` (`@plotroom/plugin-sdk`) yet, so
 * there is no `/api` seam that actually invokes these plugins' `read` in the
 * running app (see each package's own doc comments and
 * `docs/development-plan.md`'s Epic 7.3 landed-note for what that wiring
 * needs).
 */

import type { PluginManifest } from "@plotroom/plugin-sdk";
import filesystemManifest from "@plotroom/plugin-filesystem";
import gitManifest from "@plotroom/plugin-git";
import githubManifest from "@plotroom/plugin-github";
import jiraManifest from "@plotroom/plugin-jira";

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
  { pluginId: gitManifest.id, manifest: gitManifest },
  { pluginId: githubManifest.id, manifest: githubManifest },
  { pluginId: jiraManifest.id, manifest: jiraManifest },
];

/** A fresh registry, seeded with every in-box module above. */
export function createInBoxContributionRegistry(): ContributionRegistry {
  const registry = createContributionRegistry();
  for (const module of IN_BOX_PLUGIN_MODULES) {
    registry.registerManifest(module.pluginId, module.manifest);
  }
  return registry;
}
