import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  systemClock,
  type Clock,
  type Integration,
  type IntegrationConnectionState,
} from "@plotroom/core";
import type { PlotroomDatabase } from "./client.js";
import { EntityNotFound } from "./errors.js";
import { integrations, type IntegrationRow } from "./schema.js";

export interface ConnectIntegrationInput {
  readonly pluginId: string;
  readonly producerId: string;
  readonly name: string;
  readonly system: string;
  readonly scope?: string | null;
}

/**
 * Integration instances at rest (§9.1–§9.3, Epic 7.2, migration 24).
 *
 * Every rule about *what* an integration is allowed to do — refresh scheduling,
 * write-action reversibility, health from a broken connection — lives in
 * `@plotroom/core`'s `integrations/` and `attention/health.ts`. This store keeps
 * the rows: which integrations exist, what they are scoped to right now, and
 * whether their connection is live.
 */
export class IntegrationStore {
  constructor(
    private readonly state: PlotroomDatabase,
    private readonly now: Clock = systemClock,
  ) {}

  connect(input: ConnectIntegrationInput): Integration {
    const at = this.now();
    const id = `integration_${randomUUID()}`;

    this.state.db
      .insert(integrations)
      .values({
        id,
        pluginId: input.pluginId,
        producerId: input.producerId,
        name: input.name,
        system: input.system,
        scope: input.scope ?? null,
        connectionState: "connected",
        lastConnectedAt: at,
        lastRefreshAt: null,
        lastBrokenAt: null,
        lastBrokenReason: null,
        createdAt: at,
        updatedAt: at,
      })
      .run();

    return this.require(id);
  }

  get(id: string): Integration | null {
    const row = this.row(id);
    return row === undefined ? null : toIntegration(row);
  }

  list(): Integration[] {
    return this.state.db.select().from(integrations).all().map(toIntegration);
  }

  /**
   * Every connected integration whose producer declares an interval refresh —
   * the refresh job's own read (`apps/server/src/integrations/refresh-job.ts`).
   * Filtering by mode happens there, against the registry; this only excludes
   * what a schedule must never touch: a disconnected or broken integration.
   */
  connected(): Integration[] {
    return this.list().filter(
      (integration) => integration.connectionState === "connected",
    );
  }

  /**
   * Runtime-configurable scoping, changeable without restart (§9.1): a plain
   * update, because the producer reads `scope` fresh on its next `read()` call
   * rather than caching it anywhere.
   */
  updateScoping(id: string, scope: string | null): Integration {
    this.require(id);
    this.state.db
      .update(integrations)
      .set({ scope, updatedAt: this.now() })
      .where(eq(integrations.id, id))
      .run();
    return this.require(id);
  }

  disconnect(id: string): Integration {
    this.require(id);
    this.state.db
      .update(integrations)
      .set({ connectionState: "disconnected", updatedAt: this.now() })
      .where(eq(integrations.id, id))
      .run();
    return this.require(id);
  }

  /**
   * A refresh that read successfully (§9.1): the connection is healthy — even
   * from `"broken"`, because a refresh that just succeeded is the most recent
   * evidence there is — and the clock a schedule checks next against.
   */
  markRefreshed(id: string, at?: number): Integration {
    this.require(id);
    const when = at ?? this.now();
    this.state.db
      .update(integrations)
      .set({
        connectionState: "connected",
        lastConnectedAt: when,
        lastRefreshAt: when,
        lastBrokenAt: null,
        lastBrokenReason: null,
        updatedAt: when,
      })
      .where(eq(integrations.id, id))
      .run();
    return this.require(id);
  }

  /**
   * An observed failure (auth or otherwise) on a refresh (§9.3): broken is a
   * health problem, never missing data. Nothing here touches an object this
   * integration produced — they keep their last-known content (§3.2).
   */
  markBroken(id: string, reason: string, at?: number): Integration {
    this.require(id);
    const when = at ?? this.now();
    this.state.db
      .update(integrations)
      .set({
        connectionState: "broken",
        lastBrokenAt: when,
        lastBrokenReason: reason,
        updatedAt: when,
      })
      .where(eq(integrations.id, id))
      .run();
    return this.require(id);
  }

  private row(id: string): IntegrationRow | undefined {
    return this.state.db
      .select()
      .from(integrations)
      .where(eq(integrations.id, id))
      .get();
  }

  private require(id: string): Integration {
    const row = this.row(id);
    if (row === undefined) throw new EntityNotFound("integration", id);
    return toIntegration(row);
  }
}

function toIntegration(row: IntegrationRow): Integration {
  return {
    id: row.id,
    pluginId: row.pluginId,
    producerId: row.producerId,
    name: row.name,
    system: row.system,
    scope: row.scope,
    connectionState: row.connectionState as IntegrationConnectionState,
    lastConnectedAt: row.lastConnectedAt,
    lastRefreshAt: row.lastRefreshAt,
    lastBrokenAt: row.lastBrokenAt,
    lastBrokenReason: row.lastBrokenReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
