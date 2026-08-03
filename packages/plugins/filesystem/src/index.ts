/**
 * The Filesystem plugin (§9.4): "files/directories as documents; browse and
 * drag" — a conforming `PluginManifest` on the frozen contract v1
 * (`docs/plugin-contract.md`).
 *
 * Contributes:
 * - a concept producer (`producer.ts`) that reads files and directories as
 *   `document` concepts, identity = absolute path (§3.1/§3.2);
 * - a content renderer (`content-renderer.ts`) surfacing "no silent
 *   truncation" (principle 12) through the contract's own `truncated` field;
 * - a card renderer (`card-renderer.ts`), mechanics only (design gate);
 * - a "Browse" palette entry (`palette.ts`), declaration-only until the host
 *   dispatches `PaletteEntry.invoke` (§6).
 *
 * Deliberately absent: write actions, agent tools, and a workspace kind.
 * Filesystem browse/drag is read-only (§9.4 names no writes for it, unlike
 * GitHub/Jira), and there is no git-style mechanism to provision — the plain
 * files a workstream already has are read directly.
 */
import type { PluginManifest } from "@plotroom/plugin-sdk";

import { filesystemCardRenderer } from "./card-renderer.js";
import { filesystemContentRenderer } from "./content-renderer.js";
import { filesystemBrowsePaletteEntry } from "./palette.js";
import { FS_READ_PERMISSION } from "./permissions.js";
import { filesystemConceptProducer } from "./producer.js";
import { FILESYSTEM_PLUGIN_IDENTITY } from "./renderer-manifest.js";

const manifest: PluginManifest = {
  // Identity is stated once, in `renderer-manifest.ts`: the renderer half of
  // this plugin is the same plugin, and two spellings of that would be two.
  ...FILESYSTEM_PLUGIN_IDENTITY,
  permissions: [FS_READ_PERMISSION],
  contributions: {
    conceptProducers: [filesystemConceptProducer],
    contentRenderers: [filesystemContentRenderer],
    cardRenderers: [filesystemCardRenderer],
    paletteEntries: [filesystemBrowsePaletteEntry],
  },
};

export default manifest;
