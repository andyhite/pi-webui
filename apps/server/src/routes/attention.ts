import { Hono } from "hono";
import { z } from "zod";
import {
  ATTENTION_STATES,
  attentionItems,
  type AttentionState,
  type Author,
} from "@plotroom/core";
import { randomUUID } from "node:crypto";
import type { AttentionService } from "../attention/service.js";
import { badRequest, forbidden } from "../http/errors.js";
import { validateJsonBody } from "../http/validate.js";
import { actorOf, body, param, type ApiEnv, type ApiStores } from "./api.js";

/**
 * The attention queue and its outbound routes, as endpoints (§7).
 *
 * `GET /api/attention` is the one derivation, already ranked and already
 * triaged: **hiding is the source's job**, so a muted item is not in the
 * response and a snoozed one is not either until its time is up. A surface
 * ranks nothing, filters nothing, and holds no ledger of its own — it renders
 * what it is given, and the live stream (`attention` events) keeps it current.
 *
 * These are the operator's own surfaces and carry no agent tool: §7's queue is
 * where the human decides, and a session triaging the queue that reports on it
 * would be a session deciding what the operator gets to see.
 */
const triageBody = z.object({
  /** Snooze only: when it comes back. There is no "snooze forever" (§4.5). */
  snoozedUntil: z.number().int().positive().optional(),
});

const routeBody = z.object({
  name: z.string().min(1),
  /** A route attaches to a state, never to a node (§7.3). */
  state: z.enum(ATTENTION_STATES),
  url: z.string().url(),
  enabled: z.boolean().default(true),
});

const routePatchBody = z.object({
  name: z.string().min(1).optional(),
  state: z.enum(ATTENTION_STATES).optional(),
  url: z.string().url().optional(),
  enabled: z.boolean().optional(),
});

/**
 * How much of one workstream's history is "short" (§7.3). Twenty entries is
 * enough to cover a lunch break and few enough that one noisy workstream cannot
 * crowd the panel — the same reasoning as the renderer's own per-workstream cap.
 */
export const DEFAULT_ACTIVITY_CAP = 20;

export interface WorkstreamActivityEntry {
  readonly id: string;
  readonly workstreamId: string;
  readonly kind: "broadcast" | "completion" | "failure";
  readonly text: string;
  readonly at: number;
  readonly targetNodeId: string;
}

function workstreamActivity(
  stores: ApiStores,
  options: { readonly workstreamId?: string; readonly cap: number },
): readonly WorkstreamActivityEntry[] {
  const workstreams = stores.workstreams
    .list()
    .filter(
      (workstream) =>
        options.workstreamId === undefined ||
        workstream.id === options.workstreamId,
    );

  const entries: WorkstreamActivityEntry[] = [];

  for (const workstream of workstreams) {
    const perWorkstream: WorkstreamActivityEntry[] = [];

    for (const activity of stores.broadcasts.activityFor(workstream.id)) {
      perWorkstream.push({
        id: `broadcast:${activity.broadcastId}:${workstream.id}`,
        workstreamId: workstream.id,
        kind: "broadcast",
        text:
          activity.origin === "session"
            ? `${activity.senderSessionId ?? "a session"} broadcast to ${activity.recipientSessionIds.length} here (${activity.category ?? "uncategorised"})`
            : `you broadcast to ${activity.recipientSessionIds.length} here`,
        at: activity.at,
        targetNodeId:
          nodeIdOf(stores, activity.senderSessionId) ?? workstream.id,
      });
    }

    for (const stored of stores.sessions.list({
      workstreamId: workstream.id,
    })) {
      const end = stored.session.end;
      if (end === null) continue;
      const failed = end.kind === "failed";
      perWorkstream.push({
        id: `${failed ? "failure" : "completion"}:${stored.session.id}`,
        workstreamId: workstream.id,
        kind: failed ? "failure" : "completion",
        text: `${stored.session.id} ${end.kind === "failed" ? `failed: ${end.message}` : end.kind}`,
        at: end.at,
        targetNodeId: nodeIdOf(stores, stored.session.id) ?? stored.session.id,
      });
    }

    // Newest kept, oldest dropped, per workstream — so one busy workstream
    // cannot crowd another's history out of a shared list.
    perWorkstream.sort((a, b) => a.at - b.at);
    entries.push(...perWorkstream.slice(-options.cap));
  }

  return entries.sort((a, b) => a.at - b.at);
}

function nodeIdOf(stores: ApiStores, sessionId: string | null): string | null {
  if (sessionId === null) return null;
  return stores.graph.findNodeFor("session", sessionId)?.id ?? null;
}

/**
 * The operator's own gestures, enforced by the actor rather than by the
 * catalog's flag alone — the same way the claim verbs are: a flag describes, and
 * this is the gate. Triaging the queue and configuring where notifications go
 * are decisions about what the human sees and where, and a session making one
 * would be deciding that for them.
 */
function operatorOnly(actor: Author, gesture: string): void {
  if (actor.kind === "human") return;
  throw forbidden(
    `${gesture} is the operator's own gesture; a session doing it would be deciding what the human sees (§7, principle 1)`,
  );
}

export function attentionRoutes(
  stores: ApiStores,
  attention: AttentionService,
): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  /**
   * The queue (§7.1). One ranked list of everything wanting a decision, each row
   * carrying enough to answer it without opening anything.
   */
  app.get("/attention", (c) => {
    const derived = attention.derive();
    return c.json({
      items: attentionItems(derived),
      // The states each row is in, for an operator configuring a route: it is
      // the only way to see what "anything blocked" would actually have caught.
      states: Object.fromEntries(
        derived.map((entry) => [entry.item.id, entry.states]),
      ),
    });
  });

  for (const verb of ["acknowledge", "snooze", "mute"] as const) {
    app.post(`/attention/:id/${verb}`, validateJsonBody(triageBody), (c) => {
      const actor = actorOf(c);
      operatorOnly(actor, `${verb} on an attention item`);

      const input = body<z.infer<typeof triageBody>>(c);
      if (verb !== "snooze" && input.snoozedUntil !== undefined) {
        throw badRequest(
          `only a snooze has a return time; ${verb} does not take one (§4.5)`,
        );
      }

      return c.json(
        attention.triage({
          itemId: param(c, "id"),
          verb,
          by: actor,
          ...(input.snoozedUntil === undefined
            ? {}
            : { snoozedUntil: input.snoozedUntil }),
        }),
      );
    });
  }

  /** Undo a triage decision (§4.5): a mute you regret is recoverable. */
  app.delete("/attention/:id/triage", (c) => {
    operatorOnly(actorOf(c), "undoing a triage decision");
    attention.clearTriage(param(c, "id"), actorOf(c));
    return c.json({ itemId: param(c, "id"), triage: null });
  });

  /**
   * "What changed while I was away" (§7.3): each workstream's short, capped
   * history of notable events, newest last, **derived** rather than stored.
   *
   * Derived because every entry it can carry today is already a record: a
   * session-originated or operator broadcast, and a session that finished or
   * failed. A second table would be a copy of those facts that could disagree
   * with them — and one that kept saying a session failed after the record was
   * corrected. Tickets and pull requests join the same shape when Phase 7's
   * integrations land, from their own records.
   *
   * Each entry names the node it was about; whether that node is still on the
   * graph is the caller's to check (§7.3's "tolerates that target being gone" is
   * a rendering rule, and a history that dropped entries whose target went would
   * be answering a different question).
   */
  app.get("/activity", (c) => {
    const workstreamId = c.req.query("workstreamId");
    const cap = Number(c.req.query("cap") ?? DEFAULT_ACTIVITY_CAP);
    if (!Number.isInteger(cap) || cap < 1) {
      throw badRequest(`cap must be a whole number of entries (got ${cap})`);
    }

    return c.json({
      entries: workstreamActivity(stores, {
        ...(workstreamId === undefined ? {} : { workstreamId }),
        cap,
      }),
    });
  });

  /* --------------------------------------------------- outbound routes (§7.3) */

  /**
   * Routes, with their delivery health beside them. A destination that has been
   * failing is visible here rather than inferred from notifications that stopped
   * arriving.
   *
   * **Operator-only, including the read.** A route's URL is a webhook token in
   * everything but name — anyone holding it can post into the operator's chat —
   * so this read is gated like the writes rather than left open because it is a
   * GET (§9.3: credentials are exposed to nothing).
   */
  app.get("/notification-routes", (c) => {
    operatorOnly(actorOf(c), "reading the notification routes");
    return c.json({ routes: stores.attention.routes() });
  });

  app.post("/notification-routes", validateJsonBody(routeBody), (c) => {
    operatorOnly(actorOf(c), "adding a notification route");
    const input = body<z.infer<typeof routeBody>>(c);
    const route = stores.attention.createRoute({
      id: `nroute_${randomUUID()}`,
      name: input.name,
      state: input.state as AttentionState,
      url: input.url,
      enabled: input.enabled,
      at: stores.clock(),
    });

    stores.bus.publish({
      entity: "notification_route",
      verb: "created",
      route,
      author: actorOf(c),
    });
    return c.json({ route }, 201);
  });

  app.patch(
    "/notification-routes/:id",
    validateJsonBody(routePatchBody),
    (c) => {
      operatorOnly(actorOf(c), "changing a notification route");
      const input = body<z.infer<typeof routePatchBody>>(c);
      const route = stores.attention.updateRoute(param(c, "id"), {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.state === undefined
          ? {}
          : { state: input.state as AttentionState }),
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        at: stores.clock(),
      });

      stores.bus.publish({
        entity: "notification_route",
        verb: "updated",
        route,
        author: actorOf(c),
      });
      return c.json({ route });
    },
  );

  app.delete("/notification-routes/:id", (c) => {
    operatorOnly(actorOf(c), "removing a notification route");
    const routeId = param(c, "id");
    stores.attention.deleteRoute(routeId);
    stores.bus.publish({
      entity: "notification_route",
      verb: "deleted",
      routeId,
      author: actorOf(c),
    });
    return c.json({ routeId, deleted: true });
  });

  return app;
}
