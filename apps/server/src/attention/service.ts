import {
  attentionItems,
  DEFAULT_HEALTH_THRESHOLDS,
  deriveAttention,
  deriveHealthAlerts,
  type AttentionItem,
  type AttentionSources,
  type AttentionTarget,
  type Author,
  type BroadcastAttention,
  type BroadcastAttentionSource,
  type ClaimWaitObservation,
  type CompletionAttentionSource,
  type DerivedAttentionItem,
  type DomainEvent,
  type DriftAttentionSource,
  type EventEntity,
  type HealthSessionObservation,
  type HealthThresholds,
  type IntegrationHealthObservation,
  type PendingAsk,
  type SessionBroadcastCategory,
  type SessionId,
  type TriageLedger,
  type TriageVerb,
  type VersionId,
  type WorkstreamId,
  type WorkstreamPathActivity,
} from "@plotroom/core";
import { OPERATOR_CONSUMER } from "@plotroom/db";
import type { ApprovalService } from "../approvals/service.js";
import type { ClaimService } from "../claims/service.js";
import type { EventBus, Unsubscribe } from "../events/bus.js";
import { badRequest } from "../http/errors.js";
import type { Logger } from "../logging/logger.js";
import type { ApiStores } from "../routes/api.js";
import { deriveBoardDrift } from "../runs/drift.js";
import { repositoryIdsOf } from "../sessions/world.js";

/**
 * The attention derivation, server-side (§7, Epic 6.1's Stage 2).
 *
 * "One derivation, many surfaces": this class is the one. Everything it reads is
 * a record PlotRoom already keeps, and the shaping is `@plotroom/core`'s
 * (`deriveAttention`, `deriveHealthAlerts`) — what lives here is the join only
 * the stores can do, exactly like `deriveBoardDrift` beside it.
 *
 * ## Nothing here initiates anything
 *
 * The derivation is a **read**. It runs when something is observed to have
 * changed (the event stream) and, so that thresholds and snoozes can come due at
 * all, on a slow tick. Principle 2 is about the product never *originating work*;
 * a scheduled read that produces a list nobody is obliged to act on originates
 * nothing — no session is started, no run is queued, no money is spent. The tick
 * exists because "no output for ten minutes" and "hidden until 3pm" are facts
 * about elapsed time: without it the queue would only be right when something
 * else happened to change.
 *
 * ## Hiding is this class's job
 *
 * A muted item never leaves here again and a snoozed one does not leave until its
 * time is up. No surface re-filters, and none holds a ledger of its own — that is
 * the attention contract's normative rule, and it is implemented by
 * `deriveAttention` being handed the persisted ledger on every derivation.
 */
export interface AttentionConfig {
  readonly thresholds: HealthThresholds;
  /**
   * How long a finished session stays in the queue unacknowledged. A completion
   * nobody triaged a day later is history, not attention — the record is still
   * there, and it is the session card's job to show it.
   */
  readonly completionWindowSeconds: number;
  /** The same, for a session-originated broadcast (§6.5). */
  readonly broadcastWindowSeconds: number;
}

export const DEFAULT_ATTENTION_CONFIG: AttentionConfig = {
  thresholds: DEFAULT_HEALTH_THRESHOLDS,
  completionWindowSeconds: 24 * 60 * 60,
  broadcastWindowSeconds: 24 * 60 * 60,
};

export interface AttentionServiceDeps {
  readonly stores: ApiStores;
  readonly bus: EventBus;
  readonly logger: Logger;
  readonly claims: ClaimService;
  readonly approvals: ApprovalService;
  readonly config?: Partial<AttentionConfig>;
}

/**
 * The observations that count as **output** (§7.2's idle alert). A tool call is
 * not output: a session compiling for twenty minutes is working, and reporting it
 * as idle would train the operator to ignore the alert.
 */
const OUTPUT_OBSERVATION_KINDS = [
  "output-delta",
  "turn-ended",
  "session-ended",
] as const;

/**
 * Which events could change the queue. Deliberately not "everything": a
 * streaming delta arrives many times a second and changes nothing a queue row
 * renders, so re-deriving on one would spend the whole machine on a list nobody
 * asked for.
 */
const TRIGGERING_ENTITIES: ReadonlySet<EventEntity> = new Set<EventEntity>([
  "session",
  "session_question",
  "approval",
  "claim",
  "claim_wait",
  "claim_policy",
  "broadcast",
  "run",
  "version",
  "object",
  "session_transcript",
  /**
   * An integration's connection state (§9.3). A connection **breaking** is one of
   * §7.2's five health alerts, and it becomes true the moment a refresh fails — so
   * without this the alert waited for the slow tick, which is late for no reason.
   */
  "integration",
]);

export class AttentionService {
  readonly #config: AttentionConfig;
  #last = new Map<string, AttentionItem>();
  #listeners = new Set<(items: readonly DerivedAttentionItem[]) => void>();

  constructor(private readonly deps: AttentionServiceDeps) {
    this.#config = { ...DEFAULT_ATTENTION_CONFIG, ...deps.config };
  }

  /** The ranked, triaged list — items plus the states a route matches on. */
  derive(): readonly DerivedAttentionItem[] {
    const stores = this.deps.stores;
    const now = stores.clock();
    const triage = stores.attention.ledger();

    return deriveAttention(this.sources(now, triage), { now, triage });
  }

  /** What every in-app surface consumes (§7.1). */
  items(): readonly AttentionItem[] {
    return attentionItems(this.derive());
  }

  /**
   * Acknowledge, snooze, or mute (§4.5) — the same three verbs for all six
   * feeds, because "without triage verbs the queue becomes the inbox you cannot
   * clear, which is the failure it exists to prevent."
   *
   * Acknowledging a drift row advances the **consumer's baseline** through the
   * one ledger `deriveDrift` already reads, which is why the baseline version is
   * recorded rather than the acknowledgement alone: the next change past it
   * drifts again, this one does not.
   */
  triage(input: {
    readonly itemId: string;
    readonly verb: TriageVerb;
    readonly by: Author;
    readonly snoozedUntil?: number;
    readonly consumer?: string;
  }): { readonly itemId: string; readonly verb: TriageVerb } {
    const stores = this.deps.stores;
    const at = stores.clock();

    if (input.verb === "snooze") {
      if (input.snoozedUntil === undefined) {
        throw badRequest(
          "a snooze names when the item comes back; one with no return time is a mute wearing a different word (§4.5)",
        );
      }
      if (input.snoozedUntil <= at) {
        throw badRequest(
          `a snooze returns in the future (until ${input.snoozedUntil}, now ${at})`,
        );
      }
    }

    // The baseline is the version the item was shown at, so acknowledging a
    // drift row does not silently acknowledge the next change too.
    const baseline = this.baselineFor(input.itemId);

    stores.attention.triage({
      itemId: input.itemId,
      ...(input.consumer === undefined ? {} : { consumer: input.consumer }),
      verb: input.verb,
      at,
      by: input.by,
      ...(baseline === null ? {} : { baselineVersionId: baseline }),
      ...(input.snoozedUntil === undefined
        ? {}
        : { snoozedUntil: input.snoozedUntil }),
    });

    this.refresh(input.by);
    return { itemId: input.itemId, verb: input.verb };
  }

  /** Undo a triage decision — a mute you regret is recoverable like anything else. */
  clearTriage(itemId: string, by: Author, consumer?: string): void {
    this.deps.stores.attention.clearTriage(
      itemId,
      consumer ?? OPERATOR_CONSUMER,
    );
    this.refresh(by);
  }

  /**
   * Re-derive and announce what changed, one event per item (`attention`,
   * full-entity like everything else on the stream). An item that left says why:
   * a subscriber told only "gone" could not tell a snooze from a resolution.
   */
  refresh(author: Author = { kind: "human" }): readonly DerivedAttentionItem[] {
    const derived = this.derive();
    const next = new Map(derived.map((entry) => [entry.item.id, entry.item]));

    for (const [id, item] of next) {
      const previous = this.#last.get(id);
      if (previous === undefined) {
        this.deps.bus.publish({
          entity: "attention",
          verb: "created",
          item,
          author,
        });
      } else if (JSON.stringify(previous) !== JSON.stringify(item)) {
        this.deps.bus.publish({
          entity: "attention",
          verb: "updated",
          item,
          author,
        });
      }
    }

    for (const [id] of this.#last) {
      if (next.has(id)) continue;
      const record = this.deps.stores.attention.record(id);
      this.deps.bus.publish({
        entity: "attention",
        verb: "deleted",
        itemId: id,
        reason: record === undefined ? "resolved" : "triaged",
        author,
      });
    }

    this.#last = next;
    for (const listener of this.#listeners) listener(derived);
    return derived;
  }

  /** For the outbound router: every re-derivation, with the states on it. */
  onChange(
    listener: (items: readonly DerivedAttentionItem[]) => void,
  ): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Re-derive when something that could change the queue is observed. This is
   * the ordinary path; the tick only covers what elapsed time alone changes.
   */
  subscribe(): Unsubscribe {
    return this.deps.bus.subscribe((event: DomainEvent) => {
      if (!TRIGGERING_ENTITIES.has(event.entity)) return;
      try {
        this.refresh(event.author);
      } catch (error) {
        // The derivation must never be what stops: a queue that could crash the
        // event stream would take the board's live state with it.
        this.deps.logger.error("attention derivation failed", {
          entity: event.entity,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  /* ------------------------------------------------------------- the sources */

  private sources(now: number, triage: TriageLedger): AttentionSources {
    return {
      questions: this.questionSources(),
      approvals: this.approvalSources(),
      drift: this.driftSources(triage, now),
      health: this.healthSources(now),
      completions: this.completionSources(now),
      broadcasts: this.broadcastSources(now),
    };
  }

  private questionSources(): AttentionSources["questions"] {
    return this.deps.stores.questions.unanswered().map((question) => ({
      question,
      target: this.sessionTarget(question.sessionId),
    }));
  }

  /**
   * Both approval facts (§7.1): what is still asking, and what the operator
   * answered whose effect then failed. Two calls rather than one, because
   * `pendingAsks` below reads the first list as "nobody has answered this yet" and
   * an answered row in it becomes a health alert saying something false.
   */
  private approvalSources(): AttentionSources["approvals"] {
    return [
      ...this.deps.approvals.attention(),
      ...this.deps.approvals.effectFailureAttention(),
    ].map((row) => ({
      attention: row.attention,
      target: this.sessionTarget(row.approval.sessionId),
    }));
  }

  private driftSources(
    triage: TriageLedger,
    now: number,
  ): readonly DriftAttentionSource[] {
    const report = deriveBoardDrift(this.deps.stores, { triage, now });
    const sources: DriftAttentionSource[] = [];

    for (const flag of report.attention) {
      const object = this.deps.stores.objects.get(flag.objectId);
      const title = object?.title ?? flag.objectId;
      sources.push({
        flag,
        target: {
          nodeId: flag.consumer,
          workstreamId: this.workstreamOfNode(flag.consumer),
        },
        changedSummary:
          flag.cause === "direct"
            ? `${title} changed since this consumer last read it`
            : `${title} is downstream of something that changed since this consumer last read it`,
        // The flag is a state, not an event: it has been true since the version
        // it is about was written, which is when the consumer became stale.
        raisedAt:
          this.versionCreatedAt(flag.objectId, flag.latestVersionId) ?? now,
      });
    }

    return sources;
  }

  private completionSources(now: number): readonly CompletionAttentionSource[] {
    const since = now - this.#config.completionWindowSeconds;
    const sources: CompletionAttentionSource[] = [];

    for (const stored of this.deps.stores.sessions.list()) {
      const end = stored.session.end;
      if (end === null || end.at < since) continue;
      sources.push({
        sessionId: stored.session.id,
        target: this.sessionTarget(stored.session.id),
        end,
        summary: `${stored.session.id} ${describeEnd(end)}`,
      });
    }

    return sources;
  }

  private broadcastSources(now: number): readonly BroadcastAttentionSource[] {
    const stores = this.deps.stores;
    const since = now - this.#config.broadcastWindowSeconds;
    const seen = new Map<string, BroadcastAttentionSource>();

    for (const workstream of stores.workstreams.list()) {
      for (const entry of stores.broadcasts.activityFor(workstream.id)) {
        // The operator's own broadcast is not reported back to them (§6.5).
        if (entry.origin !== "session" || entry.senderSessionId === null) {
          continue;
        }
        if (entry.at < since || seen.has(entry.broadcastId)) continue;

        const row = stores.broadcasts.found(entry.broadcastId);
        const scope = row === undefined ? null : stores.broadcasts.scopeOf(row);
        if (scope === null) continue;

        const attention: BroadcastAttention = {
          kind: "session-broadcast",
          broadcastId: entry.broadcastId,
          senderSessionId: entry.senderSessionId,
          category: (entry.category ??
            "material-state-changed") as SessionBroadcastCategory,
          scope,
          recipientCount: stores.broadcasts.recipientsOf(entry.broadcastId)
            .length,
          recipientWorkstreamIds: [entry.workstreamId],
          text: entry.text,
          at: entry.at,
        };

        seen.set(entry.broadcastId, {
          attention,
          target: this.sessionTarget(entry.senderSessionId),
        });
      }
    }

    return [...seen.values()];
  }

  /* -------------------------------------------------------- health (§7.2) */

  private healthSources(now: number): AttentionSources["health"] {
    return deriveHealthAlerts({
      now,
      sessions: this.sessionObservations(),
      pendingAsks: this.pendingAsks(),
      claimWaits: this.claimWaits(now),
      workstreams: this.workstreamActivity(),
      integrations: this.integrationHealth(),
      thresholds: this.#config.thresholds,
    });
  }

  /**
   * Broken connections (§9.3, Epic 7.2): "broken connection is a health
   * problem, never missing data." Read straight off `IntegrationStore` —
   * `lastBrokenAt`/`lastBrokenReason` are set only by an observed refresh
   * failure (`IntegrationService.refresh`), never inferred from silence, so
   * this is a fold rather than a judgement (principle 7).
   *
   * `target.nodeId` carries the integration's own id: there is no canvas node
   * for an integration yet (that surface is later Phase 7 work), and a
   * synthetic, stable id here is what lets this alert's own id
   * (`healthItemId("integration-broken", ...)`) and its target agree on what
   * they mean without inventing a graph node to mean it.
   */
  private integrationHealth(): readonly IntegrationHealthObservation[] {
    return this.deps.stores.integrations
      .list()
      .filter((integration) => integration.connectionState === "broken")
      .map((integration) => ({
        integrationId: integration.id,
        name: integration.name,
        system: integration.system,
        target: { nodeId: `integration:${integration.id}`, workstreamId: null },
        since: integration.lastBrokenAt ?? this.deps.stores.clock(),
        reason: integration.lastBrokenReason ?? "connection broken",
      }));
  }

  private sessionObservations(): readonly HealthSessionObservation[] {
    const stores = this.deps.stores;
    const observations: HealthSessionObservation[] = [];

    for (const stored of stores.sessions.list()) {
      const session = stored.session;
      const live = session.end === null;
      if (!live) continue;

      const lastOutputMillis = stores.sessions.lastObservationAt(
        session.id,
        OUTPUT_OBSERVATION_KINDS,
      );
      const lastWrite = this.lastWorkspaceChange(
        session.workstreamId,
        session.id,
      );
      const blocked = this.blockedOnHuman(session.id);

      observations.push({
        sessionId: session.id,
        workstreamId: session.workstreamId,
        nodeId: this.sessionTarget(session.id).nodeId,
        live,
        startedAt: session.startedAt,
        lastOutputAt:
          lastOutputMillis === null
            ? session.startedAt
            : Math.floor(lastOutputMillis / 1000),
        lastWorkspaceChangeAt: lastWrite,
        costSinceWorkspaceChangeMicros: stores.sessions.reportedCostMicrosSince(
          session.id,
          (lastWrite ?? session.startedAt) * 1000,
        ),
        blockedOnHumanSince: blocked?.since ?? null,
        blockedOnHumanReason: blocked?.reason ?? null,
      });
    }

    return observations;
  }

  /**
   * When the operator became this session's bottleneck (§7.2's "tracked
   * separately from time spent working"): the oldest thing it is waiting on a
   * human for. Claim waits are **not** here — they alert on their own, with
   * their own threshold, which is what §7.2 asks for.
   */
  private blockedOnHuman(
    sessionId: string,
  ): { readonly since: number; readonly reason: string } | null {
    const stores = this.deps.stores;
    const waits: { readonly since: number; readonly reason: string }[] = [];

    for (const question of stores.questions.unanswered(sessionId)) {
      waits.push({
        since: question.askedAt,
        reason: "a question you have not answered",
      });
    }
    for (const approval of this.deps.approvals.pending(sessionId)) {
      waits.push({
        since: approval.raisedAt,
        reason: "an approval you have not answered",
      });
    }

    return waits.sort((a, b) => a.since - b.since)[0] ?? null;
  }

  private pendingAsks(): readonly PendingAsk[] {
    const asks: PendingAsk[] = [];

    for (const question of this.deps.stores.questions.unanswered()) {
      asks.push({
        kind: "question",
        id: question.id,
        target: this.sessionTarget(question.sessionId),
        raisedAt: question.askedAt,
        summary: question.text,
      });
    }

    for (const row of this.deps.approvals.attention()) {
      asks.push({
        kind: "approval",
        id: row.approval.id,
        target: this.sessionTarget(row.approval.sessionId),
        raisedAt: row.approval.raisedAt,
        summary: row.attention.sentence,
      });
    }

    return asks;
  }

  private claimWaits(now: number): readonly ClaimWaitObservation[] {
    const waits: ClaimWaitObservation[] = [];

    for (const workstream of this.deps.stores.workstreams.list()) {
      const metrics = this.deps.claims.waitMetrics(workstream.id);
      for (const metric of metrics.waits) {
        waits.push({
          waitId: metric.waitId,
          sessionId: metric.sessionId,
          workstreamId: workstream.id,
          nodeId: this.sessionTarget(metric.sessionId).nodeId,
          path: String(metric.path),
          since: now - metric.waitingForSeconds,
          blockedOnHuman: metric.blockedOnHuman,
        });
      }
    }

    return waits;
  }

  /**
   * What each workstream has been writing, and in which repository — the
   * cross-workstream half of "conflict predicted" (§7.2).
   *
   * A repository is its configured source (`repositoryIdsOf`), so a worktree and
   * the checkout it branched from are one repository. A workstream with no
   * workspace stands in none and is left out rather than compared against
   * everything.
   */
  private workstreamActivity(): readonly WorkstreamPathActivity[] {
    const stores = this.deps.stores;
    const activity: WorkstreamPathActivity[] = [];

    for (const workstream of stores.workstreams.list()) {
      const workspace = stores.workspaces.forWorkstream(workstream.id);
      const repositoryId =
        workspace === null ? null : (repositoryIdsOf(workspace)[0] ?? null);
      const live = stores.sessions
        .list({ workstreamId: workstream.id })
        .some((stored) => stored.session.end === null);

      const paths = new Set<string>();
      for (const write of stores.claims.writes(workstream.id)) {
        paths.add(String(write.path));
      }

      activity.push({
        workstreamId: workstream.id,
        nodeId: workstream.id,
        repositoryId,
        active: live,
        writtenPaths: [...paths],
      });
    }

    return activity;
  }

  /* ------------------------------------------------------------- joins */

  /** The node a surface navigates to for a session, falling back to its own id. */
  private sessionTarget(sessionId: string): AttentionTarget {
    const node = this.deps.stores.graph.findNodeFor("session", sessionId);
    const workstreamId =
      node?.workstreamId ??
      this.deps.stores.sessions
        .list()
        .find((stored) => stored.session.id === sessionId)?.session
        .workstreamId ??
      null;

    return {
      nodeId: node?.id ?? sessionId,
      workstreamId,
      sessionId,
    };
  }

  private workstreamOfNode(nodeId: string): string | null {
    try {
      return this.deps.stores.graph.node(nodeId).workstreamId ?? null;
    } catch {
      // A consumer whose node is gone is still a true flag; it just has no
      // workstream to name (§7.3's "tolerates that target being gone").
      return null;
    }
  }

  private versionCreatedAt(
    objectId: string,
    versionId: VersionId | null,
  ): number | null {
    if (versionId === null) return null;
    return (
      this.deps.stores.objects
        .versions(objectId)
        .find((version) => version.id === versionId)?.createdAt ?? null
    );
  }

  private lastWorkspaceChange(
    workstreamId: string,
    sessionId: string,
  ): number | null {
    let latest: number | null = null;
    for (const write of this.deps.stores.claims.writes(workstreamId)) {
      if (write.holder.kind !== "session") continue;
      if (write.holder.sessionId !== sessionId) continue;
      if (latest === null || write.at > latest) latest = write.at;
    }
    return latest;
  }

  /**
   * The version an acknowledgement advances the baseline to: the one the item
   * is about right now, so the *next* change drifts again (§4.5). Only drift
   * rows have one — the other feeds are events, not versions.
   */
  private baselineFor(itemId: string): VersionId | null {
    if (!itemId.startsWith("drift:")) return null;
    const objectId = itemId.split(":").at(2);
    if (objectId === undefined) return null;
    try {
      return this.deps.stores.objects.read(objectId).versionId as VersionId;
    } catch {
      return null;
    }
  }
}

function describeEnd(end: {
  readonly kind: string;
  readonly message?: string;
}): string {
  switch (end.kind) {
    case "completed":
      return "finished, and the world agrees it did what it set out to do";
    case "failed":
      return `failed: ${end.message ?? "no reason recorded"}`;
    case "out-of-budget":
      return "stopped because it reached a spend cap — not a failure (§8)";
    case "interrupted":
      return "was interrupted in flight and can be resumed (principle 11)";
    case "stopped":
      return "was stopped";
    case "ended-by-user":
      return "was ended";
    default:
      return `ended (${end.kind})`;
  }
}

export type { SessionId, WorkstreamId };
