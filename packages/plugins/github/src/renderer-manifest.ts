/**
 * The GitHub plugin's **renderer-side** manifest (§10.1's renderer half).
 *
 * Two halves of one plugin reach two different processes:
 *
 * - `index.ts` is the **host** entry: the manifest a worker loads, bound to a
 *   `fetch` transport, with every producer, agent tool, write action and
 *   condition check hanging off it.
 * - this module is the **renderer** entry: the card renderer, the content
 *   renderer, and the palette entry the browser itself calls through
 *   `@plotroom/ui`'s `ContributionRegistry` — nothing that talks to GitHub.
 *
 * The split is load-bearing rather than tidy: a renderer that imported a host
 * entry once took `os.tmpdir()` running at module scope with it and threw
 * before React mounted. The renderer registers renderer contributions; the
 * reach stays where the reach exists.
 *
 * `permissions` is empty because these contributions declare none — the
 * network and credential permissions the operator grants against are declared
 * on the host manifest (`plugin.ts`), which is the half that uses them.
 */
import type { PluginManifest } from "@plotroom/plugin-sdk";

import { githubClonePaletteEntry } from "./palette.js";
import {
  createGitHubCardRenderer,
  createGitHubContentRenderer,
} from "./renderers.js";

/**
 * The plugin's identity, stated once: the host manifest (`plugin.ts`) spreads
 * this same object, so the two halves cannot drift into two plugins.
 */
export const GITHUB_PLUGIN_IDENTITY = {
  id: "github",
  name: "GitHub",
  version: "1.0.0",
  contractVersion: 1,
} as const satisfies Pick<
  PluginManifest,
  "id" | "name" | "version" | "contractVersion"
>;

const rendererManifest: PluginManifest = {
  ...GITHUB_PLUGIN_IDENTITY,
  permissions: [],
  contributions: {
    contentRenderers: [createGitHubContentRenderer()],
    cardRenderers: [createGitHubCardRenderer()],
    paletteEntries: [githubClonePaletteEntry],
  },
};

export default rendererManifest;
