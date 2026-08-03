import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { UpgradeWebSocket } from "hono/ws";
import { PluginGrantStore, type PlotroomDatabase } from "@plotroom/db";
import type { ServerConfig } from "./config.js";
import { createConditionChecks } from "./conditions/registry.js";
import { startCompactionJob } from "./maintenance/compaction.js";
import type { EventBus } from "./events/bus.js";
import { actorMiddleware } from "./http/actor.js";
import { toApiError } from "./http/domain-errors.js";
import {
  credentialMiddleware,
  originCheckMiddleware,
  requestLogMiddleware,
} from "./http/middleware.js";
import type { Logger } from "./logging/logger.js";
import type { CompactionSchedule } from "./maintenance/compaction.js";
import { ApprovalService } from "./approvals/service.js";
import { destructionGuard } from "./approvals/guard.js";
import { AttentionService } from "./attention/service.js";
import { NotificationRouter } from "./attention/routing.js";
import { startAttentionTick, type AttentionTick } from "./attention/tick.js";
import { BudgetService } from "./budgets/service.js";
import { ClaimService } from "./claims/service.js";
import { createStores } from "./routes/api.js";
import { approvalRoutes } from "./routes/approvals.js";
import { attentionRoutes } from "./routes/attention.js";
import { budgetRoutes } from "./routes/budgets.js";
import { claimRoutes } from "./routes/claims.js";
import { commandRoutes } from "./routes/commands.js";
import { continuationRoutes } from "./routes/continuation.js";
import { graphRoutes } from "./routes/graph.js";
import { healthRoutes } from "./routes/health.js";
import { integrationRoutes } from "./routes/integrations.js";
import { logLevelRoutes } from "./routes/log-level.js";
import { maintenanceRoutes } from "./routes/maintenance.js";
import { objectRoutes } from "./routes/objects.js";
import { restorableRoutes } from "./routes/restorable.js";
import { runQueueRoutes } from "./routes/run-queue.js";
import { runRoutes } from "./routes/runs.js";
import { sessionRoutes } from "./routes/sessions.js";
import { snapshotRoutes } from "./routes/snapshot.js";
import { steeringRoutes } from "./routes/steering.js";
import { spendRoutes } from "./routes/spend.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { workstreamRoutes } from "./routes/workstreams.js";
import { RunQueueService } from "./runs/queue.js";
import { RunService } from "./runs/service.js";
import { createRuntimeRegistry } from "./runtime/index.js";
import { createSessionGate } from "./sessions/gate.js";
import { ContinuationService } from "./sessions/continuation.js";
import { SteeringService } from "./sessions/steering.js";
import { SessionHub } from "./sessions/hub.js";
import { serveRenderer } from "./static/serve.js";
import { nodeCommandExec } from "./workspaces/exec.js";
import { createWorkspaceKinds } from "./workspaces/kinds.js";
import { mountWsRoute } from "./ws/route.js";
import {
  startRefreshJob,
  type RefreshJob,
} from "./integrations/refresh-job.js";
import { IntegrationRegistry } from "./integrations/registry.js";
import { IntegrationService } from "./integrations/service.js";
import { integrationWorldDeclarations } from "./integrations/world.js";
import { pluginRoutes } from "./routes/plugins.js";
import { PluginService } from "./plugins/service.js";
import { standingInstructionRoutes } from "./routes/standing-instructions.js";
import { ProposalService } from "./standing-instructions/proposals.js";
import { StandingInstructionService } from "./standing-instructions/service.js";

export interface AppDependencies {
  readonly config: ServerConfig;
  readonly db: PlotroomDatabase;
  readonly bus: EventBus;
  readonly logger: Logger;
  readonly upgradeWebSocket: UpgradeWebSocket;
}

/**
 * What the run spine needs after the app is wired: the live session handles (so
 * shutdown can let go of them without ending anything) and the service that
 * recovers interrupted sessions at start (principle 11).
 */
export interface AppRuntime {
  readonly hub: SessionHub;
  readonly runs: RunService;
  /** §4.1's queue, and the subscription that lets it see a slot free. */
  readonly queue: RunQueueService;
  readonly stopQueue: () => void;
  /** §6.5's steering, and the subscription that charges induced spend. */
  readonly steering: SteeringService;
  readonly stopSteering: () => void;
  /** The scheduled version-compaction sweep (§15-3, Epic 2.3). */
  readonly compaction: CompactionSchedule;
  /** §7's one derivation, and the subscriptions that keep it current. */
  readonly attention: AttentionService;
  readonly stopAttention: () => void;
  /** The re-derivation tick: a scheduled **read**, never an initiation. */
  readonly attentionTick: AttentionTick;
  /** §7.3's outbound routes, and the deliveries in flight. */
  readonly notifications: NotificationRouter;
  readonly stopNotifications: () => void;
  /** §9.1's integration substrate, and its own scheduled-read tick. */
  readonly integrations: IntegrationService;
  readonly integrationRefresh: RefreshJob;
  /**
   * §10.2's plugin platform. `boot()` is deliberately **not** called here: it is
   * asynchronous (a worker per plugin has to load and report its health), and
   * `configureApp` is synchronous, so `apps/server/src/index.ts` starts it and the
   * routes answer honestly meanwhile — an empty list, then `loading`, then whatever
   * each plugin turned out to be. A plugin platform that made the server wait to
   * bind would be one whose failure is a product that will not start (§10.2).
   */
  readonly plugins: PluginService;
}

/**
 * Wires routes and middleware onto an already-constructed `Hono` instance.
 * Takes the instance (rather than constructing and returning one) because
 * `@hono/node-ws`'s `createNodeWebSocket` must be called with the app before
 * this module can hand it the resulting `upgradeWebSocket` — see
 * `apps/server/src/index.ts` for the wiring order.
 */
export function configureApp(app: Hono, deps: AppDependencies): AppRuntime {
  const { config, db, bus, logger, upgradeWebSocket } = deps;
  const originPolicy = { trustedOrigins: config.trustedOrigins };

  app.use("*", requestLogMiddleware(logger));

  // API and WS share the same origin/credential gate — one vocabulary, one
  // access policy (spec §12, cross-cutting rule 2).
  app.use("/api/*", originCheckMiddleware(originPolicy));
  app.use("/api/*", credentialMiddleware(config.credential));
  app.use("/ws", originCheckMiddleware(originPolicy));
  app.use("/ws", credentialMiddleware(config.credential));

  // Attribution (§15 invariant 2) is a property of the caller, so it is
  // established once for every API request rather than restated per route —
  // there is no path to a mutation that skips saying who made it.
  app.use("/api/*", actorMiddleware());

  const stores = createStores(db, bus);

  // One workspace-kind registry for the whole app: the run path provisions
  // through it, and the reset plan asks it whether a checkout is holding work
  // nothing else has (§3.4, §12).
  const workspaceKinds = createWorkspaceKinds({
    scratchDirectory: config.stateDir,
  });

  // Durability (Epic 2.3): the sweep runs on a schedule the operator configures
  // and is reachable on demand. The rule it applies is §15-3's predicate; this
  // only decides when to ask.

  const compaction = startCompactionJob({
    maintenance: stores.maintenance,
    logger,
    intervalSeconds: config.compactionIntervalSeconds,
  });

  // The run spine (Epics 4.1/4.2): one adapter registry over the runtime seam,
  // one workspace-kind registry over the mechanism contract, one condition-check
  // registry over the world conditions a submission is proven against.
  const hub = new SessionHub();

  // Path claims (§3.4). One service over `@plotroom/core`'s claim manager: the
  // run path grants the root claim at provisioning, the gate answers every write
  // from it, and the endpoints below are the same decisions as tools
  // (principle 8).
  const claims = new ClaimService({
    claims: stores.claims,
    bus,
    logger,
    clock: stores.clock,
  });
  // Approvals (§6.6, Epic 6.3). Constructed before the gate because the gate is
  // one of the two paths that raise one: a call it cannot answer from claims and
  // standing decisions alone asks, and the record is what the operator answers
  // from the queue without opening the session (§7.1).
  // Standing instructions (§3.8, Epic 7.4). The instruction half decides nothing the
  // store's predicates do not; the proposal half is what turns a session's proposal
  // into a §7.1 queue row and an accepted one into the operator's own act.
  const standingInstructions = new StandingInstructionService({
    instructions: stores.standingInstructions,
    bus,
  });
  const approvals = new ApprovalService({
    stores,
    bus,
    logger,
    hub,
    claims,
    proposals: {
      isPending: (proposalId) =>
        stores.proposals.find(proposalId)?.state === "pending",
    },
  });
  const unsubscribeClaimApprovals = approvals.subscribeToClaimWaits();
  const proposals = new ProposalService({
    proposals: stores.proposals,
    instructions: stores.standingInstructions,
    approvals,
    bus,
    logger,
    clock: stores.clock,
  });
  // Answering the queue row is answering the proposal: the fact is already on the
  // stream, so this listens rather than being called from `ApprovalService` — the
  // shape `subscribeToClaimWaits` uses in the other direction.
  const unsubscribeProposals = proposals.subscribe();

  // The integration substrate (§9.1–§9.3, Epic 7.2). Constructed here, before the
  // gate, because the gate's own `world` declarations are built from exactly
  // these producers' write actions — the Batch-4 external-write seam
  // (`decideToolPermission`) a plugin's declared reversibility plugs into.
  //
  // It starts **empty**: every producer in it arrives from an enabled plugin's
  // worker (`plugins/producers.ts`), which is what replaced the direct-invocation
  // stand-in this registry used to be handed at boot.
  const integrationRegistry = new IntegrationRegistry();
  const integrations = new IntegrationService({
    stores,
    registry: integrationRegistry,
    logger,
    approvals,
  });
  const integrationRefresh = startRefreshJob({
    integrations,
    logger,
    intervalSeconds: config.integrationTickSeconds,
    now: stores.clock,
  });

  // §10.2's plugin platform. Constructed after approvals (a raise is a §6.6 ask)
  // and after the two registries a plugin's contributions land in, and started by
  // `index.ts` rather than here — see `AppRuntime.plugins`.
  const conditions = createConditionChecks(nodeCommandExec());
  const plugins = new PluginService({
    stores,
    grants: new PluginGrantStore(db, stores.clock),
    bus,
    logger,
    integrations: integrationRegistry,
    conditions,
    approvals,
    inBox: config.pluginsInBox,
    directory: config.pluginsDirectory,
  });

  const gate = createSessionGate({
    claims,
    sessions: stores.sessions,
    logger,
    approvals,
    world: integrationWorldDeclarations(integrationRegistry),
  });

  // Budgets (§8, Epic 6.2). Constructed before the run service because the run
  // path is what acts on its answers: which caps bind a session, and what remains
  // of them, is one resolution shared by the pre-run refusal, the session-facing
  // read, and the mid-session enforcement (principle 8).
  const budgets = new BudgetService({ stores, bus, logger });

  const runs = new RunService({
    config,
    stores,
    bus,
    logger,
    budgets,
    runtimes: createRuntimeRegistry(config, logger),
    workspaceKinds,
    conditions,
    hub,
    claims,
    gate,
  });

  // Steering in flight (§6.5, §6.4, §4.2, §6.7). Constructed after the run service
  // because a batch stop and a scoped stop go through the same stop verb the run
  // path owns — one way to end a session, however the gesture was scoped.
  const steering = new SteeringService({ stores, bus, logger, hub, runs });
  // Broadcast-induced spend is charged from the session stream, like the queue's
  // admission: the observation that a recipient spent something is already
  // published, and one vocabulary beats a second notification path (§6.5).
  const unsubscribeSteering = steering.subscribe();

  // Resume, fork, and handoff (§6.3, §4.3). The tool-world declarations it needs
  // for fork cleanliness are empty until Phase 7's integrations declare any, which
  // is why cleanliness reports `unknown` wherever a session called an undeclared
  // tool — the honest answer rather than a defect.
  const continuation = new ContinuationService({
    stores,
    bus,
    logger,
    runs,
    steering,
  });

  // A runtime-raised question is the operator's to answer (§6.4), so the driver
  // hands it here to be raised rather than through the permission gate, which
  // would have denied it. Wired as a hook so the run path does not learn about
  // questions and the question path does not learn about runs.
  runs.onQuestion((input) => {
    steering.raise({
      sessionId: input.sessionId,
      text: input.request.text,
      options: input.request.options,
      requestId: input.requestId,
    });
  });

  // Scoped runs and the concurrency queue (§4.1). It subscribes to the session
  // stream rather than being called from the run path: a slot frees when a session
  // ends by any route, and the queue only ever admits work a gesture already
  // initiated (principle 2).
  const queue = new RunQueueService({
    stores,
    bus,
    logger,
    runs,
    concurrencyLimit: config.concurrencyLimit,
  });
  const unsubscribeQueue = queue.subscribe();

  // §7's one derivation. Constructed after everything it reads, and subscribed
  // to the same event stream every other live surface reads: something observed
  // changes the queue, and nothing else does — except elapsed time, which is what
  // the tick below is for (a scheduled read, principle 2).
  const attention = new AttentionService({
    stores,
    bus,
    logger,
    claims,
    approvals,
  });
  const unsubscribeAttention = attention.subscribe();
  const notifications = new NotificationRouter({
    stores,
    bus,
    logger,
    attention,
  });
  const unsubscribeNotifications = notifications.subscribe();
  const attentionTick = startAttentionTick({
    attention,
    logger,
    intervalSeconds: config.attentionTickSeconds,
  });

  // §6.6, before any route can act: a session's destructive gesture raises an
  // approval instead of executing. Registered as middleware over the whole API
  // rather than per route, because which routes it covers is catalog metadata
  // (`requires.destroys`) and a per-route list is the one that ends up missing an
  // entry.
  app.use("/api/*", destructionGuard({ approvals, logger }));

  app.route("/api", healthRoutes(db));
  app.route("/api", logLevelRoutes(logger));
  app.route("/api", workstreamRoutes(stores));
  app.route("/api", objectRoutes(stores));
  app.route("/api", graphRoutes(stores));
  app.route("/api", commandRoutes(stores));
  app.route("/api", runRoutes(stores, runs, queue));
  app.route("/api", runQueueRoutes(queue));
  app.route("/api", sessionRoutes(stores, runs, claims));
  app.route("/api", claimRoutes(claims));
  app.route("/api", spendRoutes(stores, budgets, config.concurrencyLimit));
  app.route("/api", budgetRoutes(stores, budgets));
  app.route("/api", approvalRoutes(approvals));
  app.route("/api", attentionRoutes(stores, attention));
  app.route("/api", steeringRoutes(stores, steering));
  app.route("/api", continuationRoutes(stores, continuation));
  app.route(
    "/api",
    // The diff read (§11). Read-only git through the same host-allowlisted seam
    // provisioning uses: app credentials never reach a workspace (§3.4).
    workspaceRoutes(stores, {
      exec: nodeCommandExec(),
      hostEnvironment: process.env,
    }),
  );
  app.route(
    "/api",
    maintenanceRoutes(stores, config, compaction, workspaceKinds, logger),
  );
  app.route("/api", restorableRoutes(stores));
  app.route("/api", snapshotRoutes(stores));
  app.route("/api", integrationRoutes(integrations));
  app.route("/api", pluginRoutes(plugins));
  app.route("/api", standingInstructionRoutes(standingInstructions, proposals));

  mountWsRoute({ app, path: "/ws", upgradeWebSocket, bus, logger });

  // Single-origin serving (Epic 3.0, spec §12): whatever `apps/web` builds,
  // served from the same port as /api and /ws. If it hasn't been built yet
  // (Epic 3.0 lands separately, on the same timeline), API and WS still
  // work — only the page is unavailable, and that is reported, not silent.
  // Guarded to /api and /ws paths so an unmatched API route 404s as JSON
  // instead of falling through to the SPA's index.html.
  const renderer = serveRenderer({ rootDir: config.staticDir });
  if (renderer === null) {
    logger.warn("renderer not built; serving API/WS only", {
      staticDir: config.staticDir,
    });
  }
  app.use("*", async (c, next) => {
    if (c.req.path.startsWith("/api/") || c.req.path === "/ws") {
      await next();
      return;
    }
    if (renderer === null) {
      return c.json(
        {
          error: {
            code: "renderer_not_built",
            message: `no built renderer at ${config.staticDir} (see apps/web)`,
          },
        },
        503,
      );
    }
    return renderer(c, next);
  });

  app.notFound((c) =>
    c.json(
      { error: { code: "not_found", message: `no route for ${c.req.path}` } },
      404,
    ),
  );

  app.onError((err, c) => {
    // A refusal is an answer, not a crash (Epic 2.2): a predicate's refusal
    // and an id that names nothing map to 4xx carrying the reason, and only a
    // genuine surprise is a 500.
    const api = toApiError(err);
    if (api) {
      return c.json(api.toBody(), api.status as ContentfulStatusCode);
    }
    logger.error("unhandled error", { err: String(err) });
    return c.json(
      { error: { code: "internal_error", message: "internal server error" } },
      500,
    );
  });

  return {
    hub,
    runs,
    queue,
    stopQueue: unsubscribeQueue,
    steering,
    stopSteering: unsubscribeSteering,
    compaction,
    attention,
    stopAttention: () => {
      unsubscribeAttention();
      unsubscribeClaimApprovals();
      unsubscribeProposals();
    },
    attentionTick,
    notifications,
    stopNotifications: unsubscribeNotifications,
    integrations,
    integrationRefresh,
    plugins,
  };
}
