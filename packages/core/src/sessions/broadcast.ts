import type { Author } from "../author.js";
import { humanAuthor, sessionAuthor } from "../author.js";
import type {
  EdgeId,
  NodeId,
  ObjectId,
  SessionId,
  WorkstreamId,
} from "../ids.js";
import type { LineageIndex } from "../lineage.js";
import type { RepositoryId, WorkspaceId } from "../workspaces/ids.js";
import type {
  InjectionContent,
  InjectionEdge,
  QueuedInjection,
} from "./injection.js";
import { injectionTitle } from "./injection.js";
import {
  attributeSpend,
  attributionChainFor,
  type SessionSpend,
  type SpendAttributionEntry,
} from "./tools/delegation.js";

/**
 * Broadcast (§6.5).
 *
 * "Broadcast delivers the same content to many running sessions at once — and
 * who may send one shapes what it is."
 *
 * Two gestures, deliberately different shapes rather than one shape with a flag:
 *
 * - **Human broadcast is unconstrained** — a selection, a workstream, everything
 *   currently executing. "The operator is the authority the whole system
 *   terminates at", so there is no category, no rate bound, and no lineage check
 *   on this path, and the type carries no field for any of them.
 * - **Session broadcast names a scope of shared material state, never a
 *   recipient.** `SessionBroadcastScope` has no variant that lists sessions, so a
 *   chosen list is not something a session can express. It also carries a
 *   mandatory declared category from a closed enum, is rate-bounded per sender
 *   per window, and charges induced spend to the sender's budget chain.
 *
 * ## A session broadcast may reach the sender's own chain
 *
 * This is the one place in the product where the lineage rule does **not**
 * apply, and §6.5 says why outright: "the scope rule, not lineage exclusion, is
 * what closes the collusion channel: a broadcast cannot be a covert wire to your
 * own parent when you do not choose who receives it and everyone in scope gets
 * the same thing. (Excluding the sender's chain would exclude exactly the
 * sessions most likely affected.)" So `planSessionBroadcast` does not call
 * `checkAuthoring`, on purpose, and a test asserts that a parent in scope
 * receives it. What bounds the channel instead: the scope is evaluated from
 * material state, the category is declared and auditable, the rate is bounded,
 * the spend lands on the sender, and the operator sees every one of them.
 */

export const SESSION_BROADCAST_CATEGORIES = [
  /** "Material state changed under you" — a rebase, a moved branch, a schema. */
  "material-state-changed",
  /** "Shared resource warning" — a port, a lock, a quota, a service. */
  "shared-resource-warning",
] as const;

/**
 * Closed on purpose: "an emergency channel, not a general-purpose back channel"
 * (§6.5). A session that wants to say something else has injection, which is
 * addressed, attributed, and one peer at a time.
 */
export type SessionBroadcastCategory =
  (typeof SESSION_BROADCAST_CATEGORIES)[number];

/**
 * A scope of shared material state. Note what cannot be written here: there is
 * no `sessionIds` variant, so "a chosen list" is not expressible on the session
 * path at all (§6.5).
 */
export type SessionBroadcastScope =
  | {
      readonly kind: "everyone-in-repository";
      readonly repositoryId: RepositoryId;
    }
  | {
      readonly kind: "everyone-in-workspace";
      readonly workspaceId: WorkspaceId;
    };

/** The operator's own target list — unconstrained, per §6.5. */
export type HumanBroadcastTarget =
  | { readonly kind: "selection"; readonly sessionIds: readonly SessionId[] }
  | { readonly kind: "workstream"; readonly workstreamId: WorkstreamId }
  | { readonly kind: "everything-running" };

/**
 * One running session as scope evaluation sees it: where it runs, and which
 * material state it shares. Supplied by Track A (the graph and the workspace
 * records know), because core states the rule and does not own the join.
 */
export interface BroadcastMember {
  readonly sessionId: SessionId;
  readonly workstreamId: WorkstreamId;
  /** The session node on the board — what an injection edge points at (§3.7). */
  readonly nodeId: NodeId;
  readonly workspaceId: WorkspaceId | null;
  /**
   * Every repository this session's workspace stands in. A list because a
   * composite workspace kind spans several (§13), and because a worktree and its
   * primary checkout are the same repository — which is exactly the fact
   * "everyone in this repository" is about.
   */
  readonly repositoryIds: readonly RepositoryId[];
  readonly running: boolean;
}

export interface BroadcastWorld {
  readonly members: readonly BroadcastMember[];
}

function running(world: BroadcastWorld): readonly BroadcastMember[] {
  return world.members.filter((member) => member.running);
}

/**
 * Evaluate a scope against material state. The sender's *own session* is not a
 * recipient — it already knows — but every other session in scope is, its own
 * ancestors and descendants included (see the module comment).
 */
export function evaluateSessionBroadcastScope(
  world: BroadcastWorld,
  scope: SessionBroadcastScope,
  sender: SessionId,
): readonly BroadcastMember[] {
  return running(world).filter((member) => {
    if (member.sessionId === sender) return false;
    return scope.kind === "everyone-in-repository"
      ? member.repositoryIds.includes(scope.repositoryId)
      : member.workspaceId !== null && member.workspaceId === scope.workspaceId;
  });
}

/** The operator's target list, resolved to what is actually running (§6.5, §6.7). */
export function evaluateHumanBroadcastTarget(
  world: BroadcastWorld,
  target: HumanBroadcastTarget,
): readonly BroadcastMember[] {
  const live = running(world);
  switch (target.kind) {
    case "selection": {
      const wanted = new Set<SessionId>(target.sessionIds);
      return live.filter((member) => wanted.has(member.sessionId));
    }
    case "workstream":
      return live.filter(
        (member) => member.workstreamId === target.workstreamId,
      );
    case "everything-running":
      return live;
  }
}

/* ------------------------------------------------------------- rate bounds */

/**
 * "Broadcast is the product's largest spend amplifier — one decision, twelve
 * paid turns — so it is bounded per session per window" (§6.5).
 *
 * The default: **three session broadcasts per hour per sender**. Enough for a
 * real emergency and its correction, few enough that a session cannot use it as
 * a channel. The operator's own broadcasts are not bounded at all.
 */
export interface BroadcastRatePolicy {
  readonly windowSeconds: number;
  readonly maxPerWindow: number;
}

export const DEFAULT_SESSION_BROADCAST_POLICY: BroadcastRatePolicy = {
  windowSeconds: 3_600,
  maxPerWindow: 3,
};

/** One prior send, as the bound counts them. */
export interface BroadcastSend {
  readonly senderSessionId: SessionId;
  readonly at: number;
}

export interface BroadcastRateCheck {
  readonly allowed: boolean;
  readonly sentInWindow: number;
  readonly policy: BroadcastRatePolicy;
  /** How long until the oldest send leaves the window; 0 when allowed. */
  readonly retryAfterSeconds: number;
}

export function checkBroadcastRate(
  history: readonly BroadcastSend[],
  sender: SessionId,
  now: number,
  policy: BroadcastRatePolicy = DEFAULT_SESSION_BROADCAST_POLICY,
): BroadcastRateCheck {
  const since = now - policy.windowSeconds;
  const inWindow = history
    .filter((send) => send.senderSessionId === sender && send.at > since)
    .sort((a, b) => a.at - b.at);

  if (inWindow.length < policy.maxPerWindow) {
    return {
      allowed: true,
      sentInWindow: inWindow.length,
      policy,
      retryAfterSeconds: 0,
    };
  }

  // The bound frees up when the oldest send in the window ages out of it.
  const oldest = inWindow[
    inWindow.length - policy.maxPerWindow
  ] as BroadcastSend;
  return {
    allowed: false,
    sentInWindow: inWindow.length,
    policy,
    retryAfterSeconds: Math.max(1, oldest.at + policy.windowSeconds - now),
  };
}

/**
 * The bound with the clock injected, for callers that would otherwise read the
 * wall clock at the call site (`ClaimManager`'s shape). Recording is the
 * caller's `record` call, so a refused broadcast never counts against the bound.
 */
export interface BroadcastRateLimiter {
  check(sender: SessionId): BroadcastRateCheck;
  record(sender: SessionId): void;
  history(): readonly BroadcastSend[];
}

export function createBroadcastRateLimiter(options: {
  readonly now: () => number;
  readonly policy?: BroadcastRatePolicy;
  readonly history?: readonly BroadcastSend[];
}): BroadcastRateLimiter {
  const policy = options.policy ?? DEFAULT_SESSION_BROADCAST_POLICY;
  let sends: readonly BroadcastSend[] = options.history ?? [];

  return {
    check: (sender) => checkBroadcastRate(sends, sender, options.now(), policy),
    record: (sender) => {
      sends = [...sends, { senderSessionId: sender, at: options.now() }];
    },
    history: () => sends,
  };
}

/* ------------------------------------------------------------------- plans */

export type BroadcastId = string;

/** Ids for one recipient's copy. Derived from the batch key by the caller. */
export interface BroadcastRecipientIds {
  readonly injectionId: string;
  readonly edgeId: EdgeId;
  readonly ordinal: number;
}

export interface BroadcastIds {
  readonly broadcastId: BroadcastId;
  /** One content object for the whole broadcast: the same content, once (§6.5). */
  readonly objectId: ObjectId;
  readonly nodeId: NodeId;
  forRecipient(sessionId: SessionId): BroadcastRecipientIds;
}

export interface BroadcastDelivery {
  readonly sessionId: SessionId;
  readonly workstreamId: WorkstreamId;
  readonly edge: InjectionEdge;
  readonly ledgerEntry: QueuedInjection;
}

export interface BroadcastPlan {
  readonly broadcastId: BroadcastId;
  readonly origin: "human" | "session";
  readonly senderSessionId: SessionId | null;
  readonly category: SessionBroadcastCategory | null;
  readonly scope: SessionBroadcastScope | null;
  readonly target: HumanBroadcastTarget | null;
  readonly author: Author;
  readonly text: string;
  /** One content node, wired to every recipient — the same content, permanently. */
  readonly content: InjectionContent;
  readonly deliveries: readonly BroadcastDelivery[];
  /**
   * Whose budgets the induced turns are charged to (§6.5, principle 2). Empty on
   * the human path: the operator's gesture has no session chain behind it.
   */
  readonly spendChargedTo: readonly SessionId[];
  readonly at: number;
}

export const BROADCAST_REFUSAL_REASONS = [
  /** Nothing running matches the declared scope, so nothing was sent. */
  "empty_scope",
  /** The per-sender window is full (§6.5). */
  "rate_limited",
] as const;

export type BroadcastRefusalReason = (typeof BROADCAST_REFUSAL_REASONS)[number];

export interface BroadcastRefusal {
  readonly reason: BroadcastRefusalReason;
  readonly message: string;
  readonly retryAfterSeconds?: number;
}

export type BroadcastResult =
  | { readonly ok: true; readonly plan: BroadcastPlan }
  | { readonly ok: false; readonly refusal: BroadcastRefusal };

function contentFor(input: {
  readonly ids: BroadcastIds;
  readonly text: string;
  readonly category: SessionBroadcastCategory | null;
  readonly at: number;
}): InjectionContent {
  const label =
    input.category === null
      ? injectionTitle(input.text)
      : `[${input.category}] ${injectionTitle(input.text)}`;
  return {
    objectId: input.ids.objectId,
    nodeId: input.ids.nodeId,
    kind: "note",
    scope: "local",
    // The category is on the content itself, not only on the send record: §6.5
    // wants a broadcast that "cannot masquerade as task context", and the node a
    // reader finds wired into twelve sessions is where that has to be visible.
    title: label,
    body: input.text,
    createdAt: input.at,
  };
}

function deliveriesFor(
  recipients: readonly BroadcastMember[],
  input: {
    readonly ids: BroadcastIds;
    readonly author: Author;
    readonly text: string;
    readonly at: number;
  },
): readonly BroadcastDelivery[] {
  return recipients.map((member) => {
    const ids = input.ids.forRecipient(member.sessionId);
    return {
      sessionId: member.sessionId,
      workstreamId: member.workstreamId,
      edge: {
        id: ids.edgeId,
        kind: "context",
        from: input.ids.nodeId,
        to: member.nodeId,
        author: input.author,
        ordinal: ids.ordinal,
        createdAt: input.at,
      },
      ledgerEntry: {
        id: ids.injectionId,
        sessionId: member.sessionId,
        author: input.author,
        nodeId: input.ids.nodeId,
        text: input.text,
        queuedAt: input.at,
      },
    };
  });
}

export interface HumanBroadcastRequest {
  readonly ids: BroadcastIds;
  readonly target: HumanBroadcastTarget;
  readonly text: string;
  readonly at: number;
}

/** The operator's broadcast: no category, no bound, no lineage check (§6.5). */
export function planHumanBroadcast(
  world: BroadcastWorld,
  request: HumanBroadcastRequest,
): BroadcastResult {
  const recipients = evaluateHumanBroadcastTarget(world, request.target);
  if (recipients.length === 0) {
    return {
      ok: false,
      refusal: {
        reason: "empty_scope",
        message: "nothing is running in that selection, so nothing was sent",
      },
    };
  }

  return {
    ok: true,
    plan: {
      broadcastId: request.ids.broadcastId,
      origin: "human",
      senderSessionId: null,
      category: null,
      scope: null,
      target: request.target,
      author: humanAuthor,
      text: request.text,
      content: contentFor({ ...request, category: null }),
      deliveries: deliveriesFor(recipients, {
        ids: request.ids,
        author: humanAuthor,
        text: request.text,
        at: request.at,
      }),
      spendChargedTo: [],
      at: request.at,
    },
  };
}

export interface SessionBroadcastRequest {
  readonly ids: BroadcastIds;
  readonly senderSessionId: SessionId;
  readonly scope: SessionBroadcastScope;
  /** Mandatory, and from the closed enum — the type has no other option (§6.5). */
  readonly category: SessionBroadcastCategory;
  readonly text: string;
  readonly at: number;
}

export interface SessionBroadcastContext {
  readonly world: BroadcastWorld;
  /** Prior sends, for the per-sender window. */
  readonly history: readonly BroadcastSend[];
  readonly policy?: BroadcastRatePolicy;
  /** The lineage index, used only to compute who pays — never to exclude. */
  readonly lineage: LineageIndex;
}

/**
 * A session's broadcast. Every §6.5 constraint is applied here, in one place:
 * the scope is evaluated against material state, the category rides on the
 * content, the rate bound refuses with a retry-after, and the plan names the
 * sender's whole chain as what the induced turns are charged to.
 */
export function planSessionBroadcast(
  context: SessionBroadcastContext,
  request: SessionBroadcastRequest,
): BroadcastResult {
  const rate = checkBroadcastRate(
    context.history,
    request.senderSessionId,
    request.at,
    context.policy,
  );
  if (!rate.allowed) {
    return {
      ok: false,
      refusal: {
        reason: "rate_limited",
        message: `a session may broadcast ${rate.policy.maxPerWindow} times per ${rate.policy.windowSeconds} seconds; this is send ${rate.sentInWindow + 1} (§6.5)`,
        retryAfterSeconds: rate.retryAfterSeconds,
      },
    };
  }

  const recipients = evaluateSessionBroadcastScope(
    context.world,
    request.scope,
    request.senderSessionId,
  );
  if (recipients.length === 0) {
    return {
      ok: false,
      refusal: {
        reason: "empty_scope",
        // Refused rather than delivered-to-nobody so the bound is not spent and
        // the sender learns the scope is empty instead of assuming it landed.
        message:
          "no other running session shares that material state, so nothing was sent",
      },
    };
  }

  const author = sessionAuthor(request.senderSessionId);

  return {
    ok: true,
    plan: {
      broadcastId: request.ids.broadcastId,
      origin: "session",
      senderSessionId: request.senderSessionId,
      category: request.category,
      scope: request.scope,
      target: null,
      author,
      text: request.text,
      content: contentFor(request),
      deliveries: deliveriesFor(recipients, {
        ids: request.ids,
        author,
        text: request.text,
        at: request.at,
      }),
      spendChargedTo: attributionChainFor(
        context.lineage,
        request.senderSessionId,
      ),
      at: request.at,
    },
  };
}

/**
 * "Its induced spend counts against the sender's budget chain (the sender caused
 * it; anything else lets a session spend from budgets that do not bind it, a
 * hole in principle 2's transitive guarantee)."
 *
 * One recipient's induced turn produces rows for the recipient (`own` — it still
 * spent its own budget) and for every session in the sender's chain
 * (`descendant` — they caused it). A recipient that happens to *be* in the
 * sender's chain gets one row, as `own`, because `attributeSpend` keys on the
 * spender; the chain is deduped here so a two-row charge is impossible.
 */
export function attributeBroadcastSpend(
  plan: BroadcastPlan,
  spend: SessionSpend,
): readonly SpendAttributionEntry[] {
  const chain = [spend.sessionId, ...plan.spendChargedTo];
  return attributeSpend([...new Set(chain)], spend);
}

/* ------------------------------------------------- what the operator sees */

/**
 * "The operator sees it: a session-originated broadcast appears in the queue and
 * in each recipient workstream's activity history. An agent telling twelve other
 * agents something is exactly the class of event worth knowing happened."
 *
 * Two shapes, because those are two surfaces: one attention row for the send,
 * and one activity entry per recipient workstream. Track A publishes both; core
 * decides what they say, so the queue and the history cannot describe the same
 * broadcast differently.
 */
export interface BroadcastAttention {
  readonly kind: "session-broadcast";
  readonly broadcastId: BroadcastId;
  readonly senderSessionId: SessionId;
  readonly category: SessionBroadcastCategory;
  readonly scope: SessionBroadcastScope;
  readonly recipientCount: number;
  readonly recipientWorkstreamIds: readonly WorkstreamId[];
  readonly text: string;
  readonly at: number;
}

/** Null for a human broadcast: the operator does not need telling what they did. */
export function broadcastAttention(
  plan: BroadcastPlan,
): BroadcastAttention | null {
  if (
    plan.origin !== "session" ||
    plan.senderSessionId === null ||
    plan.category === null ||
    plan.scope === null
  ) {
    return null;
  }
  return {
    kind: "session-broadcast",
    broadcastId: plan.broadcastId,
    senderSessionId: plan.senderSessionId,
    category: plan.category,
    scope: plan.scope,
    recipientCount: plan.deliveries.length,
    recipientWorkstreamIds: [
      ...new Set(plan.deliveries.map((delivery) => delivery.workstreamId)),
    ],
    text: plan.text,
    at: plan.at,
  };
}

export interface BroadcastActivityEntry {
  readonly workstreamId: WorkstreamId;
  readonly broadcastId: BroadcastId;
  readonly origin: "human" | "session";
  readonly senderSessionId: SessionId | null;
  readonly category: SessionBroadcastCategory | null;
  readonly recipientSessionIds: readonly SessionId[];
  readonly text: string;
  readonly at: number;
}

/** One entry per recipient workstream, human broadcasts included (§7.3). */
export function broadcastActivity(
  plan: BroadcastPlan,
): readonly BroadcastActivityEntry[] {
  const byWorkstream = new Map<WorkstreamId, SessionId[]>();
  for (const delivery of plan.deliveries) {
    const existing = byWorkstream.get(delivery.workstreamId);
    if (existing) existing.push(delivery.sessionId);
    else byWorkstream.set(delivery.workstreamId, [delivery.sessionId]);
  }

  return [...byWorkstream.entries()].map(([workstreamId, sessionIds]) => ({
    workstreamId,
    broadcastId: plan.broadcastId,
    origin: plan.origin,
    senderSessionId: plan.senderSessionId,
    category: plan.category,
    recipientSessionIds: sessionIds,
    text: plan.text,
    at: plan.at,
  }));
}
