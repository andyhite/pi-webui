import type {
  AttentionItem,
  AttentionState,
  DerivedAttentionItem,
} from "./types.js";

/**
 * Outbound notification routing (§7.3).
 *
 * "The attention system cannot assume eyes on the canvas; the real failure is
 * several agents blocked while you are at lunch. Outbound notification routing
 * sends attention to destinations the user configures — a push service, a chat
 * webhook — with the same edge-triggered discipline as the in-app surfaces and
 * with sensitive content redacted. A route attaches to a _state_ ('anything
 * blocked', 'anything failed'), not to a node."
 *
 * Three decisions are stated here rather than at the delivery site, because each
 * is a rule and not an implementation detail:
 *
 * 1. **A route attaches to a state.** Nothing about a route names a node, a
 *    session, or a workstream, so a board that grew overnight is covered without
 *    anyone drawing anything.
 * 2. **Edge-triggered, folded by id.** An item notifies once per occurrence. It
 *    can notify again only after it has genuinely left the visible set — the same
 *    discipline the in-app notification uses, so a snoozed item that returns is a
 *    new arrival to both and neither re-fires while it sits there.
 * 3. **Titles and summaries pass; content bodies never.** {@link redactForRoute}
 *    is the whole rule, and it is a whitelist: what leaves the machine is the
 *    item's id, feed, state, target ids, timestamp, and one-line summary. No
 *    transcript, no object content, no broadcast or injection text, no tool
 *    input, no question free text beyond the summary the operator already reads
 *    on the row. A webhook is an unencrypted URL on someone else's server (§9.3),
 *    so the safe direction is a whitelist that cannot silently grow when a
 *    payload does.
 */
export const NOTIFICATION_DESTINATION_KINDS = ["webhook"] as const;

export type NotificationDestinationKind =
  (typeof NOTIFICATION_DESTINATION_KINDS)[number];

/**
 * A webhook, and for now only a webhook: a generic JSON POST reaches Slack,
 * Discord, ntfy, and anything an operator can put a relay in front of. Push
 * services need per-vendor credentials and a per-vendor payload, which is plugin
 * territory (§9) rather than a second thing to keep working here.
 */
export type NotificationDestination = {
  readonly kind: "webhook";
  readonly url: string;
};

export interface NotificationRoute {
  readonly id: string;
  readonly name: string;
  readonly state: AttentionState;
  readonly destination: NotificationDestination;
  /** Disabled routes are kept, not deleted: a paused route is still configured. */
  readonly enabled: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly health: NotificationRouteHealth;
}

/**
 * Whether the destination is actually working, reported rather than thrown.
 *
 * "Delivery failures are reported as route health, never crash": a chat webhook
 * that has been revoked must not be able to stop the attention derivation, and an
 * operator whose notifications quietly stopped needs to see *that* rather than
 * infer it from silence.
 */
export interface NotificationRouteHealth {
  readonly lastAttemptAt: number | null;
  readonly lastSuccessAt: number | null;
  readonly lastFailureAt: number | null;
  readonly lastFailureReason: string | null;
  readonly consecutiveFailures: number;
}

export const NEW_ROUTE_HEALTH: NotificationRouteHealth = {
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailureReason: null,
  consecutiveFailures: 0,
};

export function routeMatches(
  route: NotificationRoute,
  derived: DerivedAttentionItem,
): boolean {
  if (!route.enabled) return false;
  if (route.state === "anything") return true;
  return derived.states.includes(route.state);
}

/**
 * The body that leaves the machine, whitelisted field by field.
 *
 * Note what is absent and why: `payload` is not here at all. It carries a
 * question's text and options, a drift summary, a broadcast's category — some of
 * which is content and all of which is only needed by a surface that can *answer*
 * the row. A webhook cannot answer anything; it says "this is waiting, come
 * look", and `url` is where to come.
 */
export interface RoutedNotification {
  readonly routeId: string;
  readonly routeName: string;
  readonly state: AttentionState;
  readonly itemId: string;
  readonly feed: AttentionItem["feed"];
  /** The one line the operator reads on the row — titles pass, bodies do not. */
  readonly summary: string;
  readonly nodeId: string;
  readonly workstreamId: string | null;
  readonly sessionId: string | null;
  readonly raisedAt: number;
  /** Named in the payload so a recipient knows it is reading a redacted view. */
  readonly redaction: "summary-only";
}

/**
 * How much of a summary crosses the wire. Long enough for any row this product
 * words, short enough that a summary someone widened into a content dump is
 * truncated rather than delivered whole.
 */
export const ROUTED_SUMMARY_MAX_CHARS = 300;

export function redactForRoute(
  route: NotificationRoute,
  derived: DerivedAttentionItem,
): RoutedNotification {
  const item = derived.item;
  return {
    routeId: route.id,
    routeName: route.name,
    state: route.state,
    itemId: item.id,
    feed: item.feed,
    summary: item.summary.slice(0, ROUTED_SUMMARY_MAX_CHARS),
    nodeId: item.target.nodeId,
    workstreamId: item.target.workstreamId,
    sessionId: item.target.sessionId ?? null,
    raisedAt: item.raisedAt,
    redaction: "summary-only",
  };
}

/**
 * The edge-trigger, as a pure fold (§7.3's "same discipline as the in-app
 * surfaces"): what fires now, and what the route has seen.
 *
 * `fired` is the set of item ids this route has already delivered and which are
 * still visible. Ids that have left the visible set are dropped, which is what
 * makes a genuinely new occurrence of the same item — a snooze that elapsed, a
 * health alert that cleared and returned — notify again while a row that simply
 * sits in the queue never does.
 */
export interface RouteEdgeDecision {
  readonly fire: readonly DerivedAttentionItem[];
  readonly nextFired: ReadonlySet<string>;
}

export function decideRouteFires(
  route: NotificationRoute,
  visible: readonly DerivedAttentionItem[],
  fired: ReadonlySet<string>,
): RouteEdgeDecision {
  const matching = visible.filter((derived) => routeMatches(route, derived));
  const matchingIds = new Set(matching.map((derived) => derived.item.id));
  const nextFired = new Set([...fired].filter((id) => matchingIds.has(id)));

  const fire = matching.filter((derived) => !fired.has(derived.item.id));
  for (const derived of fire) nextFired.add(derived.item.id);

  return { fire, nextFired };
}
