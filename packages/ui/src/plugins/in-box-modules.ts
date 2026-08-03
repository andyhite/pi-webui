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
 * contributions. **Jira** (`@plotroom/plugin-jira`) lands here the same way:
 * tickets, epics-as-collections, and workflow-as-document card, content, and
 * palette (search-by-JQL) contributions.
 *
 * **Every import here is a plugin's `./renderer-manifest` entry, never its
 * default one.** A plugin has two halves that run in two different processes:
 * the host manifest its `index.ts` default-exports, built with real,
 * machine-touching dependencies (git's `node:child_process` spawner and
 * scratch directory, filesystem's `node:fs`, GitHub's and Jira's `fetch`
 * transports), and the renderer manifest — card, content, and palette
 * contributions and nothing else — which is what a browser can actually run.
 * Importing the host half here is not merely wasteful: it shipped
 * `os.tmpdir()` into the bundle, where it ran at module scope and threw, so
 * the whole renderer died before React mounted and every panel on the canvas
 * went with it (the batch 4 gate caught exactly that). The producers, agent
 * tools, write actions and condition checks reach the running app through
 * `apps/server/src/plugins/`, which hosts the default manifests in
 * `worker_threads` — never through this module.
 */

import type { PluginManifest } from "@plotroom/plugin-sdk";
import filesystemManifest from "@plotroom/plugin-filesystem/renderer-manifest";
import gitManifest from "@plotroom/plugin-git/renderer-manifest";
import githubManifest from "@plotroom/plugin-github/renderer-manifest";
import jiraManifest from "@plotroom/plugin-jira/renderer-manifest";

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
