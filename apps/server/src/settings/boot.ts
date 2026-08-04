import type { SettingRow } from "@plotroom/db";
import type { ServerConfig } from "../config.js";
import { checkSettingValue, findSetting, writePath } from "./catalog.js";

export interface StoredSettingsResult {
  readonly config: ServerConfig;
  /**
   * Overrides that were **not** applied, each with the reason — never silently
   * dropped, because a setting the operator can see in `GET /api/settings` and
   * this process is not actually running under is a surface lying about itself.
   */
  readonly ignored: readonly {
    readonly key: string;
    readonly reason: string;
  }[];
}

/**
 * Layers persisted settings overrides onto the env-derived config, once at
 * boot (Epic 2.1's deferred seam: "`loadServerConfig` takes explicit
 * overrides so the eventual settings store has a seam to call into instead
 * of env directly").
 *
 * The caller's own `config` — whatever `loadServerConfig` produced, test
 * overrides included — is what a persisted override is layered *onto*, and
 * is exactly the value `SettingsService` calls its "default" (an override
 * removed later reverts to precisely this, never to a second recomputation
 * of `process.env` that could disagree with what this process actually
 * started with). An override for a key the catalog no longer declares is
 * skipped rather than applied blindly: a setting a past build wrote and this
 * one retired must not silently reach for a field that no longer means what
 * it did.
 *
 * A stored value the catalog would refuse as a **write** is skipped for the same
 * reason, judged by the same `checkSettingValue` the route uses — wrong type or
 * outside its bound. It is not a hypothetical: before the bound was stated in
 * one place (`config.ts`'s `NumericBound`), the settings route accepted a
 * `concurrencyLimit` of zero, and every boot afterwards read it back and refused
 * every admission; a stored `"abc"` reached the queue as its limit and did the
 * same thing. Refusing the value here rather than at the write alone is what
 * makes that unwedgeable — a store written by an older build, or edited by hand,
 * cannot make this process unusable, and the env-derived default is what it runs
 * under instead.
 *
 * Both kinds of skip are returned rather than logged here (there is no logger
 * this early) and nothing about them is silent: `startServer` logs each one, and
 * `SettingsService` reports the reason on the setting itself, so the read cannot
 * show a stored value the process is not running under.
 */
export function applyStoredSettings(
  config: ServerConfig,
  rows: readonly SettingRow[],
): StoredSettingsResult {
  if (rows.length === 0) return { config, ignored: [] };

  const ignored: { key: string; reason: string }[] = [];
  const next = structuredClone(config) as unknown as Record<string, unknown>;

  for (const row of rows) {
    const entry = findSetting(row.key);
    if (!entry) {
      ignored.push({
        key: row.key,
        reason: "this build declares no such setting",
      });
      continue;
    }

    const value = JSON.parse(row.valueJson) as unknown;
    const wrong = checkSettingValue(entry, value);
    if (wrong !== null) {
      ignored.push({
        key: row.key,
        reason: `stored value ${JSON.stringify(value)} is not ${wrong}; running the default instead`,
      });
      continue;
    }

    writePath(next, entry.path, value);
  }

  return { config: next as unknown as ServerConfig, ignored };
}
