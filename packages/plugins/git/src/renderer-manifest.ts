/**
 * The Coding/git plugin's **renderer-side** manifest (§10.1's renderer half).
 *
 * Two halves of one plugin reach two different processes, and only one of them
 * can touch the machine:
 *
 * - `index.ts` is the **host** entry: the manifest a worker loads, built with a
 *   `node:child_process` spawner, a disk probe, and a scratch directory — every
 *   producer, agent tool, condition check and workspace kind hangs off it.
 * - this module is the **renderer** entry: the card and content renderers the
 *   browser itself calls through `@plotroom/ui`'s `ContributionRegistry`, and
 *   nothing else. It imports `renderers.js` alone, so no `node:` builtin can
 *   reach the bundle a browser loads.
 *
 * That split is load-bearing rather than tidy: the renderer imported this
 * package's host entry once, and `os.tmpdir()` running at module scope threw in
 * the browser before React mounted — every panel on the canvas gone, because a
 * plugin's *server* half was in the page. The renderer registers renderer
 * contributions; a producer's reach stays where the reach exists.
 *
 * `permissions` is empty because the renderer contributions declare none: a
 * card renderer is handed an already-produced object and answers with a view.
 * The permissions git actually asks the host for are declared on the host
 * manifest (`plugin.ts`), which is what the operator grants against.
 */
import type { PluginManifest } from "@plotroom/plugin-sdk";

import {
  createGitCardRenderer,
  createGitContentRenderer,
} from "./renderers.js";

/**
 * The plugin's identity, stated once: the host manifest (`plugin.ts`) spreads
 * this same object, so the two halves cannot drift into two plugins.
 */
export const GIT_PLUGIN_IDENTITY = {
  id: "coding-git",
  name: "Coding / git",
  version: "1.0.0",
  contractVersion: 1,
} as const satisfies Pick<
  PluginManifest,
  "id" | "name" | "version" | "contractVersion"
>;

const rendererManifest: PluginManifest = {
  ...GIT_PLUGIN_IDENTITY,
  permissions: [],
  contributions: {
    contentRenderers: [createGitContentRenderer()],
    cardRenderers: [createGitCardRenderer()],
  },
};

export default rendererManifest;
