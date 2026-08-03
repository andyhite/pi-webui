import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * The plugins that ship **in the box** (§10.2's first distribution channel).
 *
 * A list, deliberately: distribution v1 is "in-box plus a configured directory",
 * and the in-box half is data rather than four hand-written registration calls —
 * Jira joins it by gaining a line here when its package lands (Epic 7.3), and
 * nothing else changes.
 *
 * Each entry names a **package**, not a path. The entry point resolved is the one
 * the package's own `exports` declares (`dist/index.js`), which is exactly what a
 * packaged build ships and exactly what each plugin's own host test already loads —
 * so the module the product runs is the module those tests proved.
 *
 * A package that cannot be resolved is an **install failure with a reason**
 * ({@link InBoxResolution.reason}), never a silent absence: a build that forgot to
 * bundle a plugin must say so on the health surface rather than answer as though
 * the plugin did not exist (principle 12, §10.2).
 */
export interface InBoxPluginEntry {
  /** The plugin id its manifest declares, for the failure message alone. */
  readonly pluginId: string;
  readonly packageName: string;
  /**
   * A module URL to load instead of resolving `packageName`.
   *
   * Present only for a plugin the app already knows the location of — a test
   * fixture, or a packaging layout that resolves its own entry points. The id still
   * comes from the manifest, never from this string (§10.2).
   */
  readonly entry?: string;
}

/**
 * The three in-box plugins that exist today. Jira (§9.4's fourth) is not here
 * because its package does not exist yet — an entry pointing at nothing would be a
 * permanent install failure claiming a plugin was shipped.
 */
export const IN_BOX_PLUGINS: readonly InBoxPluginEntry[] = [
  { pluginId: "coding-git", packageName: "@plotroom/plugin-git" },
  { pluginId: "github", packageName: "@plotroom/plugin-github" },
  { pluginId: "filesystem", packageName: "@plotroom/plugin-filesystem" },
];

export type InBoxResolution =
  | {
      readonly ok: true;
      readonly pluginId: string;
      readonly packageName: string;
      /** A `file:` URL, so the worker imports the same specifier on every platform. */
      readonly entry: string;
    }
  | {
      readonly ok: false;
      readonly pluginId: string;
      readonly packageName: string;
      readonly reason: string;
    };

/**
 * Resolve every in-box entry against this process's module resolution.
 *
 * `createRequire` rather than a relative path: the layout of `node_modules` (or of
 * a packaged app's resources) is the packager's business, and a hard-coded
 * `../../packages/...` would work in the repository and nowhere else.
 */
export function resolveInBoxPlugins(
  entries: readonly InBoxPluginEntry[] = IN_BOX_PLUGINS,
): readonly InBoxResolution[] {
  const require = createRequire(import.meta.url);
  return entries.map((entry) => {
    if (entry.entry !== undefined) {
      return {
        ok: true,
        pluginId: entry.pluginId,
        packageName: entry.packageName,
        entry: entry.entry,
      };
    }
    try {
      const resolved = require.resolve(entry.packageName);
      return {
        ok: true,
        pluginId: entry.pluginId,
        packageName: entry.packageName,
        entry: pathToFileURL(resolved).href,
      };
    } catch (error) {
      return {
        ok: false,
        pluginId: entry.pluginId,
        packageName: entry.packageName,
        reason: `${entry.packageName} could not be resolved: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  });
}
