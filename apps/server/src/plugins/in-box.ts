import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The plugins that ship **in the box** (§10.2's first distribution channel).
 *
 * A list, deliberately: distribution v1 is "in-box plus a configured directory",
 * and the in-box half is data rather than four hand-written registration calls —
 * Jira joined it by gaining a line here when its package landed (Epic 7.3), and
 * nothing else changed.
 *
 * Each entry names a **package**, not a path. The entry point resolved is the one
 * the package's own `exports` declares (`src/index.ts`, #315: no build, raw-TS
 * exports, resolved directly by Bun), which is exactly what each plugin's own
 * host test already loads — so the module the product runs is the module those
 * tests proved.
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
 * §9.4's four in-box plugins, all of them shipping today.
 *
 * Each `pluginId` is here for the failure message alone — the id the product uses is
 * the one the manifest declares, which is why a renamed directory or a mistyped line
 * here cannot silently become a different plugin (§10.2).
 */
export const IN_BOX_PLUGINS: readonly InBoxPluginEntry[] = [
  { pluginId: "coding-git", packageName: "@plotroom/plugin-git" },
  { pluginId: "github", packageName: "@plotroom/plugin-github" },
  { pluginId: "filesystem", packageName: "@plotroom/plugin-filesystem" },
  { pluginId: "jira", packageName: "@plotroom/plugin-jira" },
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
      const resolved = compiledEntry(require.resolve(entry.packageName));
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

/**
 * Map a source-condition resolution back to the package's compiled entry.
 *
 * The dev server runs from TypeScript source (`--conditions=source`, see the
 * workspace packages' `exports`), and that condition reaches this resolver too —
 * but a plugin worker deliberately starts with `execArgv: []` (no inherited
 * loaders), so the module it imports must be compiled JavaScript. When the
 * resolution landed on a `.ts` file, walk up to the package's own manifest and
 * take the `default` condition — the exact entry a packaged build resolves.
 * A `.js` resolution (every production path) passes through untouched.
 */
function compiledEntry(resolved: string): string {
  if (!resolved.endsWith(".ts")) return resolved;
  let dir = path.dirname(resolved);
  for (;;) {
    const manifestPath = path.join(dir, "package.json");
    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) {
        throw new Error(`no package.json above source entry ${resolved}`);
      }
      dir = parent;
      continue;
    }
    const entry = defaultCondition(
      (manifest as { exports?: Record<string, unknown> }).exports?.["."],
    );
    if (typeof entry !== "string") {
      throw new Error(`${manifestPath} declares no default "." export`);
    }
    return path.resolve(dir, entry);
  }
}

/** The `default` branch of one `exports` entry, however it is nested. */
function defaultCondition(entry: unknown): unknown {
  if (typeof entry === "string") return entry;
  if (entry !== null && typeof entry === "object") {
    return defaultCondition((entry as Record<string, unknown>).default);
  }
  return undefined;
}
