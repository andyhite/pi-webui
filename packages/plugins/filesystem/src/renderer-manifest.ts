/**
 * The Filesystem plugin's **renderer-side** manifest (§10.1's renderer half).
 *
 * Two halves of one plugin reach two different processes:
 *
 * - `index.ts` is the **host** entry: the manifest a worker loads, carrying the
 *   concept producer that reads real files (`node:fs/promises`).
 * - this module is the **renderer** entry: the card renderer, the content
 *   renderer, and the browse palette entry the browser itself calls through
 *   `@plotroom/ui`'s `ContributionRegistry` — nothing that touches a disk.
 *
 * The split is load-bearing rather than tidy: a renderer that imported a host
 * entry once took `os.tmpdir()` running at module scope with it and threw
 * before React mounted. The renderer registers renderer contributions; the
 * reach stays where the reach exists.
 *
 * `permissions` is empty because these contributions declare none — the
 * filesystem read permission the operator grants against is declared on the
 * host manifest (`index.ts`), which is the half that reads files.
 */
import type { PluginManifest } from "@plotroom/plugin-sdk";

import { filesystemCardRenderer } from "./card-renderer.js";
import { filesystemContentRenderer } from "./content-renderer.js";
import { filesystemBrowsePaletteEntry } from "./palette.js";

/**
 * The plugin's identity, stated once: the host manifest (`index.ts`) spreads
 * this same object, so the two halves cannot drift into two plugins.
 */
export const FILESYSTEM_PLUGIN_IDENTITY = {
  id: "filesystem",
  name: "Filesystem",
  version: "1.0.0",
  contractVersion: 1,
} as const satisfies Pick<
  PluginManifest,
  "id" | "name" | "version" | "contractVersion"
>;

const rendererManifest: PluginManifest = {
  ...FILESYSTEM_PLUGIN_IDENTITY,
  permissions: [],
  contributions: {
    contentRenderers: [filesystemContentRenderer],
    cardRenderers: [filesystemCardRenderer],
    paletteEntries: [filesystemBrowsePaletteEntry],
  },
};

export default rendererManifest;
