import { and, eq } from "drizzle-orm";
import { systemClock, type Clock } from "@plotroom/core";
import type { PlotroomDatabase } from "./client.js";
import { pluginGrants, type PluginGrantRow } from "./schema.js";

/**
 * What the operator has answered about a plugin's declared permissions, at rest
 * (§10.2, §9.3, migration 25).
 *
 * The whole policy lives in the shape of the table, so this class decides nothing:
 *
 * - **Two states only.** A row is `granted` or `denied`; a permission with no row
 *   is `never-asked`, which is the state a runtime reach raises through §6.6.
 *   {@link PluginGrantStore.remove} deletes the row rather than writing a third
 *   state — "grant or remove", the same shape budgets use.
 * - **No expiry.** A grant that lapsed on a clock would change what a plugin may
 *   do with nobody behind it (principle 2); the contract's `PermissionState` has
 *   no `expired` member for the same reason.
 * - **No value of any kind.** A grant names a permission id, never a credential's
 *   value — those live in `CredentialStore` and leave the process only through the
 *   host's per-call injection (§9.3).
 */
export interface PluginGrantRecord {
  readonly pluginId: string;
  readonly permissionId: string;
  readonly state: "granted" | "denied";
  readonly answeredAt: number;
}

export class PluginGrantStore {
  constructor(
    private readonly state: PlotroomDatabase,
    private readonly now: Clock = systemClock,
  ) {}

  /** Every answer, for the health surface's per-permission display. */
  list(): PluginGrantRecord[] {
    return this.state.db.select().from(pluginGrants).all().map(toRecord);
  }

  forPlugin(pluginId: string): PluginGrantRecord[] {
    return this.state.db
      .select()
      .from(pluginGrants)
      .where(eq(pluginGrants.pluginId, pluginId))
      .all()
      .map(toRecord);
  }

  /**
   * Record the operator's answer. Idempotent by (plugin, permission): answering
   * again replaces the answer rather than accumulating rows, because the question
   * "may this plugin do X" has one current answer.
   */
  answer(input: {
    readonly pluginId: string;
    readonly permissionId: string;
    readonly state: "granted" | "denied";
    readonly at?: number;
  }): PluginGrantRecord {
    const answeredAt = input.at ?? this.now();
    this.state.db
      .insert(pluginGrants)
      .values({
        pluginId: input.pluginId,
        permissionId: input.permissionId,
        state: input.state,
        answeredAt,
      })
      .onConflictDoUpdate({
        target: [pluginGrants.pluginId, pluginGrants.permissionId],
        set: { state: input.state, answeredAt },
      })
      .run();

    return {
      pluginId: input.pluginId,
      permissionId: input.permissionId,
      state: input.state,
      answeredAt,
    };
  }

  /** Un-answer it: the permission goes back to `never-asked`, and may raise again. */
  remove(pluginId: string, permissionId: string): void {
    this.state.db
      .delete(pluginGrants)
      .where(
        and(
          eq(pluginGrants.pluginId, pluginId),
          eq(pluginGrants.permissionId, permissionId),
        ),
      )
      .run();
  }

  /** Everything a removed plugin had been answered about. */
  clear(pluginId: string): void {
    this.state.db
      .delete(pluginGrants)
      .where(eq(pluginGrants.pluginId, pluginId))
      .run();
  }
}

function toRecord(row: PluginGrantRow): PluginGrantRecord {
  return {
    pluginId: row.pluginId,
    permissionId: row.permissionId,
    state: row.state,
    answeredAt: row.answeredAt,
  };
}
