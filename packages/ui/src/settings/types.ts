/**
 * Settings (§11, §8, Epic 8.3): "grouped, searchable, applied without
 * restart. Everything configurable is a setting; environment variables
 * only supply defaults." The shape mirrors `GET /api/settings(/:key)`
 * (`apps/server/src/routes/settings.ts`, catalog in
 * `apps/server/src/settings/catalog.ts`) field for field.
 */

import type { Unsubscribe } from "../data-source/types.js";

export type SettingType = "string" | "number" | "boolean" | "enum" | "string[]";

export interface SettingRow {
  readonly key: string;
  readonly group: string;
  readonly label: string;
  readonly description: string;
  readonly type: SettingType;
  readonly enumValues?: readonly string[];
  readonly envVar: string | null;
  /** Never carries the real value in a read — render `value` honestly instead. */
  readonly sensitive: boolean;
  /**
   * True only where a real mechanism applies the write with no restart
   * (the catalog's own asserted guarantee). Render this, never assume it.
   */
  readonly appliesWithoutRestart: boolean;
  /** Set exactly when `appliesWithoutRestart` is false — what stays fixed until the next start. */
  readonly restartReason?: string;
  /** `"[redacted]"` for a sensitive setting with a value set; the real value, otherwise. */
  readonly value: unknown;
  readonly defaultValue: unknown;
  readonly overridden: boolean;
}

/** What the `setting` WS event carries (`@plotroom/core`'s `SettingChange`) — a live nudge to refetch, not a full row. */
export interface SettingChangeNotice {
  readonly key: string;
  readonly value: unknown;
  readonly overridden: boolean;
  readonly appliesWithoutRestart: boolean;
}

export interface SettingsDataSource {
  /** Grouped/searchable list; `q` matches label, description, group, or key. */
  list(q?: string): Promise<readonly SettingRow[]>;
  get(key: string): Promise<SettingRow>;
  /** Applies a new value — "grant or remove" is a separate verb, never this one clearing a value. */
  set(key: string, value: unknown): Promise<SettingRow>;
  /** The other verb: reverts to the catalog's default, distinct from writing an empty value. */
  remove(key: string): Promise<SettingRow>;
  /** Fires on every `setting` WS event — a signal to refetch, not the row itself. */
  subscribe(onChange: (notice: SettingChangeNotice) => void): Unsubscribe;
}
