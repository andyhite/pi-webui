import { eq } from "drizzle-orm";
import { systemClock, type Clock } from "@plotroom/core";
import type { PlotroomDatabase } from "./client.js";
import { settings, type SettingRow } from "./schema.js";

/**
 * Settings overrides at rest (§11, §8, Epic 8.3).
 *
 * The catalog — which keys exist, how they group, what type each is, whether
 * it applies without a restart — is code in `apps/server/src/settings/`. This
 * store knows none of that; it is a plain key/value table, exactly like
 * `PluginDisablementStore`'s relationship to plugin lifecycle: a row means
 * "overridden from the env-derived default", and removing it reverts to that
 * default rather than writing a third state.
 */
export class SettingsStore {
  constructor(
    private readonly state: PlotroomDatabase,
    private readonly now: Clock = systemClock,
  ) {}

  /** Every overridden key, for the boot that must apply them all. */
  list(): SettingRow[] {
    return this.state.db.select().from(settings).all();
  }

  get(key: string): SettingRow | undefined {
    return this.state.db
      .select()
      .from(settings)
      .where(eq(settings.key, key))
      .get();
  }

  /** Overwrites whatever the key held; the caller has already validated it. */
  set(key: string, valueJson: string): SettingRow {
    const updatedAt = this.now();
    this.state.db
      .insert(settings)
      .values({ key, valueJson, updatedAt })
      .onConflictDoUpdate({
        target: settings.key,
        set: { valueJson, updatedAt },
      })
      .run();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- just written
    return this.get(key)!;
  }

  /** Reverts to the env-derived default: an absence, not a third state. */
  remove(key: string): void {
    this.state.db.delete(settings).where(eq(settings.key, key)).run();
  }
}
