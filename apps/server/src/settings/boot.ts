import type { SettingRow } from "@plotroom/db";
import type { ServerConfig } from "../config.js";
import { findSetting, writePath } from "./catalog.js";

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
 */
export function applyStoredSettings(
  config: ServerConfig,
  rows: readonly SettingRow[],
): ServerConfig {
  if (rows.length === 0) return config;

  const next = structuredClone(config) as unknown as Record<string, unknown>;
  for (const row of rows) {
    const entry = findSetting(row.key);
    if (!entry) continue;
    writePath(next, entry.path, JSON.parse(row.valueJson) as unknown);
  }
  return next as unknown as ServerConfig;
}
