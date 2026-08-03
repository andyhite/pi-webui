import { systemClock, type Author, type Clock } from "@plotroom/core";
import {
  ApprovalStore,
  AttentionStore,
  BroadcastStore,
  BudgetStore,
  ClaimStore,
  CommandStore,
  CredentialStore,
  GraphStore,
  IntegrationStore,
  Maintenance,
  ObjectStore,
  ProposalStore,
  QuestionStore,
  RunQueueStore,
  RunStore,
  SessionStore,
  SpendStore,
  StandingInstructionStore,
  WorkspaceStore,
  WorkstreamStore,
  type PlotroomDatabase,
} from "@plotroom/db";
import type { EventBus } from "../events/bus.js";
import { badRequest } from "../http/errors.js";

/**
 * What every Epic 2.2 route is handed: the stores that own the rules and the
 * bus every successful mutation announces itself on. Nothing here reimplements
 * a rule — the stores call the predicates in `@plotroom/core`, so the API, the
 * canvas, and agent tools refuse identically (principle 8).
 */
export interface ApiStores {
  readonly db: PlotroomDatabase;
  readonly bus: EventBus;
  /**
   * Unix seconds, the vocabulary every `created_at` in the schema uses. Shared
   * with the stores so a test that drives time drives all of it (retention,
   * idempotency, and end timestamps are untestable against a real clock).
   */
  readonly clock: Clock;
  readonly objects: ObjectStore;
  readonly graph: GraphStore;
  readonly workstreams: WorkstreamStore;
  readonly commands: CommandStore;
  readonly runs: RunStore;
  /** Scoped runs and the concurrency queue (§4.1, Epic 5.5). */
  readonly queue: RunQueueStore;
  readonly sessions: SessionStore;
  /** Path claims at rest; every rule over them is `@plotroom/core`'s (§3.4). */
  readonly claims: ClaimStore;
  /** Structured questions (§6.4): the record outlives the call it blocks. */
  readonly questions: QuestionStore;
  /** Broadcasts, their rate window, and handoff briefs (§6.5, §6.3). */
  readonly broadcasts: BroadcastStore;
  /** Approvals and the standing decisions that answer for them (§6.6). */
  readonly approvals: ApprovalStore;
  /** Triage for every attention feed, and the outbound routes (§4.5, §7.3). */
  readonly attention: AttentionStore;
  /** Spend attributed up the initiating chain (§3.6, principle 2). */
  readonly spend: SpendStore;
  /** Budgets at workstream and global scope (§8); a run's cap lives on the run. */
  readonly budgets: BudgetStore;
  readonly workspaces: WorkspaceStore;
  /** Durability, cleanup, and the compaction sweep (§12, Epic 2.3). */
  readonly maintenance: Maintenance;
  /** Integration instances: connection, scoping, and refresh history (§9.1–§9.3). */
  readonly integrations: IntegrationStore;
  /** Credentials for integrations — never read by a route's own response (§9.3). */
  readonly credentials: CredentialStore;
  /** Standing instructions and their per-workstream opt-ins (§3.8). */
  readonly standingInstructions: StandingInstructionStore;
  /** A session's proposals, awaiting the human who accepts them (principle 1). */
  readonly proposals: ProposalStore;
}

export function createStores(
  db: PlotroomDatabase,
  bus: EventBus,
  clock: Clock = systemClock,
): ApiStores {
  return {
    db,
    bus,
    clock,
    objects: new ObjectStore(db, clock),
    graph: new GraphStore(db, clock),
    workstreams: new WorkstreamStore(db, clock),
    commands: new CommandStore(db, clock),
    runs: new RunStore(db, clock),
    queue: new RunQueueStore(db, clock),
    sessions: new SessionStore(db, clock),
    claims: new ClaimStore(db, clock),
    questions: new QuestionStore(db, clock),
    broadcasts: new BroadcastStore(db, clock),
    approvals: new ApprovalStore(db, clock),
    attention: new AttentionStore(db, clock),
    spend: new SpendStore(db, clock),
    budgets: new BudgetStore(db, clock),
    // The workspace record's own vocabulary is milliseconds (§3.4), so its
    // clock is the same instant at a different resolution, never a second
    // source of time.
    workspaces: new WorkspaceStore(db, () => clock() * 1000),
    maintenance: new Maintenance(db, clock),
    integrations: new IntegrationStore(db, clock),
    credentials: new CredentialStore(db, clock),
    standingInstructions: new StandingInstructionStore(db, clock),
    proposals: new ProposalStore(db, clock),
  };
}

/**
 * `actor` is set by the attribution middleware for every request; `body` by
 * `validateJsonBody` for the routes that take one.
 */
export interface ApiEnv {
  readonly Variables: {
    actor: Author;
    body: unknown;
  };
}

/**
 * The accessors below take the smallest shape they need rather than a
 * `Context<ApiEnv>`: `validateJsonBody` intersects the env with the schema it
 * validated, so a handler's context is a *narrower* type than the route's,
 * and pinning these to one env would make every validated route fail to
 * typecheck for a reason that has nothing to do with the route.
 */
export interface ActorAware {
  get(key: "actor"): Author;
}

export interface BodyAware {
  get(key: "body"): unknown;
}

export interface ParamAware {
  readonly req: { param(name: string): string | undefined };
}

/** The validated body, typed by the schema the route declared. */
export function body<T>(c: BodyAware): T {
  return c.get("body") as T;
}

export function actorOf(c: ActorAware): Author {
  return c.get("actor");
}

/**
 * A matched path parameter. Absent means the route pattern and the read
 * disagree — a bug, reported rather than passed on as `undefined`.
 */
export function param(c: ParamAware, name: string): string {
  const value = c.req.param(name);
  if (value === undefined) throw badRequest(`missing path parameter ${name}`);
  return value;
}
