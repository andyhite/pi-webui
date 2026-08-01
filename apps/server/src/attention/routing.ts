import {
  decideRouteFires,
  redactForRoute,
  type DerivedAttentionItem,
  type NotificationRoute,
  type RoutedNotification,
} from "@plotroom/core";
import type { EventBus, Unsubscribe } from "../events/bus.js";
import { redact } from "../logging/logger.js";
import type { Logger } from "../logging/logger.js";
import type { ApiStores } from "../routes/api.js";
import type { AttentionService } from "./service.js";

/**
 * Outbound notification delivery (§7.3).
 *
 * "The attention system cannot assume eyes on the canvas; the real failure is
 * several agents blocked while you are at lunch." Every rule this obeys is
 * `@plotroom/core`'s `attention/routing.ts` — a route attaches to a **state**,
 * fires **edge-triggered** by item id, and carries a **redacted** body. What
 * lives here is the POST and the bookkeeping around it.
 *
 * Two properties are worth stating because both are about not making things
 * worse:
 *
 * - **A broken destination is route health, never an exception.** A revoked
 *   webhook, a DNS failure, a 500 from someone's chat server: all recorded on the
 *   route and visible on `GET /api/notification-routes`. Nothing here throws into
 *   the derivation that feeds it.
 * - **What was sent is written down before the next derivation.** The fired set
 *   is persisted per route, so a restart between two derivations does not re-fire
 *   every open item at once.
 */
export interface NotificationRouterDeps {
  readonly stores: ApiStores;
  readonly bus: EventBus;
  readonly logger: Logger;
  readonly attention: AttentionService;
  /** Injected so a test asserts the body rather than the network. */
  readonly deliver?: WebhookDelivery;
}

export type WebhookDelivery = (
  url: string,
  body: RoutedNotification,
) => Promise<
  { readonly ok: true } | { readonly ok: false; readonly reason: string }
>;

/**
 * The default: a plain JSON POST, which is what a chat webhook, a relay, or an
 * ntfy topic takes. Push services need per-vendor credentials and per-vendor
 * payloads, which is plugin territory (§9) rather than a second surface here.
 */
export const httpWebhookDelivery: WebhookDelivery = async (url, body) => {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.ok
      ? { ok: true }
      : { ok: false, reason: `the destination answered ${response.status}` };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

export class NotificationRouter {
  readonly #deliver: WebhookDelivery;
  #inFlight: Promise<void> = Promise.resolve();

  constructor(private readonly deps: NotificationRouterDeps) {
    this.#deliver = deps.deliver ?? httpWebhookDelivery;
  }

  /** Fire whatever is newly visible on each route. Never throws. */
  async dispatch(visible: readonly DerivedAttentionItem[]): Promise<void> {
    const stores = this.deps.stores;

    for (const route of stores.attention.routes()) {
      if (!route.enabled) continue;

      const fired = stores.attention.firedItems(route.id);
      const decision = decideRouteFires(route, visible, fired);

      // The fired set is saved even when nothing fires: an item that left has to
      // be forgotten, or a genuinely new occurrence of it would never notify.
      stores.attention.saveFired(route.id, decision.nextFired, stores.clock());
      if (decision.fire.length === 0) continue;

      for (const item of decision.fire) {
        await this.send(route, item);
      }
    }
  }

  /**
   * Subscribe to the derivation. Deliveries are chained rather than fired in
   * parallel so two derivations in quick succession cannot interleave their
   * writes to one route's fired set and lose one.
   */
  subscribe(): Unsubscribe {
    return this.deps.attention.onChange((visible) => {
      this.#inFlight = this.#inFlight
        .then(() => this.dispatch(visible))
        .catch((error: unknown) => {
          this.deps.logger.error("notification dispatch failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        });
    });
  }

  /** Waits for deliveries already scheduled — for shutdown and for tests. */
  drain(): Promise<void> {
    return this.#inFlight;
  }

  private async send(
    route: NotificationRoute,
    item: DerivedAttentionItem,
  ): Promise<void> {
    // Redacted by core's whitelist, then passed through the same credential
    // redaction every log line gets — belt and braces, because this body leaves
    // the machine and a summary somebody widened is the way a secret would get
    // out (§9.3).
    const body = redact(
      redactForRoute(route, item),
    ) as unknown as RoutedNotification;

    const result = await this.#deliver(route.destination.url, body);
    const updated = this.deps.stores.attention.recordDelivery(
      route.id,
      result,
      this.deps.stores.clock(),
    );

    if (!result.ok) {
      this.deps.logger.warn("a notification route is failing", {
        routeId: route.id,
        reason: result.reason,
        consecutiveFailures: updated.health.consecutiveFailures,
      });
    }

    // The route's health is state a surface renders, so it travels on the one
    // event stream like everything else.
    this.deps.bus.publish({
      entity: "notification_route",
      verb: "updated",
      route: updated,
      author: { kind: "human" },
    });
  }
}
