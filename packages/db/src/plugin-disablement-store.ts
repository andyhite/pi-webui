import { eq } from "drizzle-orm";
import { systemClock, type Clock } from "@plotroom/core";
import type { PlotroomDatabase } from "./client.js";
import { pluginDisablements } from "./schema.js";

/**
 * Which plugins the operator disabled (§10.2, migration 28).
 *
 * A row means disabled and an absence means enabled — the same "two facts, one of
 * them an absence" shape `PluginGrantStore` uses, and enabling deletes the row
 * rather than writing a second state.
 *
 * It exists because the registry's own `state` is a *running process's* property.
 * Without this, boot enabled every installed plugin, so an operator's disable lasted
 * until the next restart and then quietly undid itself — a decision reversed with
 * nobody behind it, which is the failure the budget's "removal stays removed" was
 * written about.
 *
 * There is deliberately no reason column and no expiry. Why a plugin is *unavailable*
 * is health, observed on the running record (§10.2), and a plugin re-enabling itself
 * on a clock would change what it may do with nobody behind it (principle 2).
 */
export class PluginDisablementStore {
  constructor(
    private readonly state: PlotroomDatabase,
    private readonly now: Clock = systemClock,
  ) {}

  /** Every plugin the operator turned off, for the boot that must honour it. */
  list(): readonly string[] {
    return this.state.db
      .select()
      .from(pluginDisablements)
      .all()
      .map((row) => row.pluginId);
  }

  isDisabled(pluginId: string): boolean {
    return (
      this.state.db
        .select()
        .from(pluginDisablements)
        .where(eq(pluginDisablements.pluginId, pluginId))
        .get() !== undefined
    );
  }

  /** Idempotent: disabling a disabled plugin keeps the first decision's time. */
  disable(pluginId: string): void {
    this.state.db
      .insert(pluginDisablements)
      .values({ pluginId, disabledAt: this.now() })
      .onConflictDoNothing()
      .run();
  }

  /** Enabled is the absence of a row, so this deletes it. */
  enable(pluginId: string): void {
    this.state.db
      .delete(pluginDisablements)
      .where(eq(pluginDisablements.pluginId, pluginId))
      .run();
  }
}
