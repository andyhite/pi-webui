import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { systemClock, type Clock } from "@plotroom/core";
import type { PlotroomDatabase } from "./client.js";
import { integrationCredentials } from "./schema.js";

/**
 * Credentials, at rest, for an integration (§9.3): "credentials are stored by
 * the app and exposed to no session and no other plugin."
 *
 * **The enforcement is what this class does not have**: there is no method here
 * that returns a value to something that could put it in an HTTP response, an
 * event, or a log line. `reveal` exists for exactly one caller shape — the
 * per-call injection seam a write action or a producer read runs through
 * (`apps/server/src/integrations/service.ts`) — and it is named `reveal` rather
 * than `get` so a reviewer sees the one place it is safe to call.
 *
 * `list`/`names` (below) answer "does a credential named X exist" without ever
 * touching the value, which is what the connect-flow UI needs to show "connected"
 * without needing the secret back.
 */
export class CredentialStore {
  constructor(
    private readonly state: PlotroomDatabase,
    private readonly now: Clock = systemClock,
  ) {}

  put(integrationId: string, name: string, value: string): void {
    const existing = this.state.db
      .select({ id: integrationCredentials.id })
      .from(integrationCredentials)
      .where(
        and(
          eq(integrationCredentials.integrationId, integrationId),
          eq(integrationCredentials.name, name),
        ),
      )
      .get();

    if (existing) {
      this.state.db
        .update(integrationCredentials)
        .set({ value })
        .where(eq(integrationCredentials.id, existing.id))
        .run();
      return;
    }

    this.state.db
      .insert(integrationCredentials)
      .values({
        id: `credential_${randomUUID()}`,
        integrationId,
        name,
        value,
        createdAt: this.now(),
      })
      .run();
  }

  /**
   * The only method that returns a secret's value. Never called from a route
   * handler's response — only from the call boundary that injects it into a
   * plugin's `read`/`perform`, by name, the way §9.3 describes.
   */
  reveal(integrationId: string, name: string): string | null {
    const row = this.state.db
      .select({ value: integrationCredentials.value })
      .from(integrationCredentials)
      .where(
        and(
          eq(integrationCredentials.integrationId, integrationId),
          eq(integrationCredentials.name, name),
        ),
      )
      .get();
    return row?.value ?? null;
  }

  /** Whether a named credential exists, with no value in the answer. */
  has(integrationId: string, name: string): boolean {
    return this.reveal(integrationId, name) !== null;
  }

  /** Which names are stored for an integration — never their values. */
  names(integrationId: string): string[] {
    return this.state.db
      .select({ name: integrationCredentials.name })
      .from(integrationCredentials)
      .where(eq(integrationCredentials.integrationId, integrationId))
      .all()
      .map((row) => row.name);
  }

  /** Cascades on `disconnect`'s own delete of the integration row too. */
  clear(integrationId: string): void {
    this.state.db
      .delete(integrationCredentials)
      .where(eq(integrationCredentials.integrationId, integrationId))
      .run();
  }
}
