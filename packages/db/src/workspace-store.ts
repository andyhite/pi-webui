import { eq, isNull } from "drizzle-orm";
import {
  checkReady,
  checkRootOwnership,
  checkWorkspaceBoundary,
  newWorkspaceId,
  newWorkspaceRecord,
  systemMillisClock,
  type Author,
  type MillisClock,
  type ProvisionCost,
  type ReadinessRecord,
  type SessionId,
  type Workspace,
  type WorkspaceFingerprint,
  type WorkspaceId,
  type WorkspaceKindConfig,
  type WorkspaceKindName,
  type WorkspaceRoot,
  type WorkstreamId,
} from "@plotroom/core";
import type { PlotroomDatabase } from "./client.js";
import { EntityNotFound } from "./errors.js";
import { workspaces, type WorkspaceRow } from "./schema.js";

/**
 * Why a workspace operation was refused. Every reason comes from a predicate in
 * `@plotroom/core` — the boundary rule, the root-ownership rule, the readiness
 * gate — so the canvas, the API, and agent tools refuse identically
 * (principle 8).
 */
export interface WorkspaceRefusal {
  readonly reason: string;
  readonly message: string;
}

export class WorkspaceRefused extends Error {
  constructor(readonly refusal: WorkspaceRefusal) {
    super(refusal.message);
    this.name = "WorkspaceRefused";
  }
}

export interface CreateWorkspaceInput {
  readonly workstreamId: string;
  readonly kind: WorkspaceKindName;
  readonly config: WorkspaceKindConfig;
  readonly author: Author;
}

export interface ProvisionedInput {
  readonly roots: readonly WorkspaceRoot[];
  readonly cost: ProvisionCost;
  readonly readiness: ReadinessRecord;
}

/**
 * Workspace records (spec §3.4, Epic 4.3's deferred persistence).
 *
 * `@plotroom/core`'s `workspaces/` subtree owns the shape and every rule over
 * it; this store keeps the rows and calls those predicates rather than
 * restating them. Creating a record provisions nothing — the run path
 * provisions at first run (§3.4, §3.5) — so a fresh row has no roots and a
 * readiness of `unprovisioned`, which is exactly what blocks a run with a
 * visible reason.
 *
 * Timestamps here are milliseconds, the workspace record's own vocabulary.
 */
export class WorkspaceStore {
  constructor(
    private readonly state: PlotroomDatabase,
    private readonly now: MillisClock = systemMillisClock,
  ) {}

  /**
   * Create the record for a workstream. Refused when the workstream already has
   * one: "one workstream owns exactly one workspace" is the product's boundary,
   * checked by the predicate here and made unrepresentable by the partial
   * unique index in migration 7.
   */
  create(input: CreateWorkspaceInput): Workspace {
    const boundary = checkWorkspaceBoundary(
      { workstreamId: input.workstreamId as WorkstreamId },
      this.all(),
    );
    if (!boundary.allowed) throw new WorkspaceRefused(boundary.refusal);

    const record = newWorkspaceRecord(
      {
        id: newWorkspaceId(),
        workstreamId: input.workstreamId as WorkstreamId,
        kind: input.kind,
        config: input.config,
        createdBy: input.author,
      },
      this.now(),
    );

    this.state.db.insert(workspaces).values(toRow(record)).run();

    return this.get(record.id);
  }

  get(workspaceId: string): Workspace {
    const row = this.state.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .get();
    if (!row) throw new EntityNotFound("workspace", workspaceId);
    return toWorkspace(row);
  }

  /** The workstream's live workspace, or null — a workstream may have none yet. */
  forWorkstream(workstreamId: string): Workspace | null {
    const row = this.state.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.workstreamId, workstreamId))
      .all()
      .find((each) => each.removedAt === null);

    return row ? toWorkspace(row) : null;
  }

  /** Every record the product knows about, removed ones included. */
  all(): Workspace[] {
    return this.state.db
      .select()
      .from(workspaces)
      .all()
      .map((row) => toWorkspace(row));
  }

  live(): Workspace[] {
    return this.state.db
      .select()
      .from(workspaces)
      .where(isNull(workspaces.removedAt))
      .all()
      .map((row) => toWorkspace(row));
  }

  setReadiness(workspaceId: string, readiness: ReadinessRecord): Workspace {
    this.state.db
      .update(workspaces)
      .set({ readinessJson: JSON.stringify(readiness) })
      .where(eq(workspaces.id, workspaceId))
      .run();

    return this.get(workspaceId);
  }

  /**
   * Record what provisioning produced. The root-ownership half of the boundary
   * is checked here rather than at the call site, because this is the moment
   * paths are known: no workstream is handed a place another one is working in.
   */
  recordProvisioned(workspaceId: string, input: ProvisionedInput): Workspace {
    const workspace = this.get(workspaceId);
    const ownership = checkRootOwnership(workspace, input.roots, this.all());
    if (!ownership.allowed) throw new WorkspaceRefused(ownership.refusal);

    this.state.db
      .update(workspaces)
      .set({
        rootsJson: JSON.stringify(input.roots),
        readinessJson: JSON.stringify(input.readiness),
        provisionedAt: this.now(),
        provisionCostJson: JSON.stringify(input.cost),
      })
      .where(eq(workspaces.id, workspaceId))
      .run();

    return this.get(workspaceId);
  }

  setFingerprint(
    workspaceId: string,
    fingerprint: WorkspaceFingerprint,
  ): Workspace {
    this.state.db
      .update(workspaces)
      .set({ lastFingerprintJson: JSON.stringify(fingerprint) })
      .where(eq(workspaces.id, workspaceId))
      .run();

    return this.get(workspaceId);
  }

  /** Soft removal, like every destructive operation on authored state (§10). */
  remove(workspaceId: string): Workspace {
    this.get(workspaceId);
    this.state.db
      .update(workspaces)
      .set({ removedAt: this.now() })
      .where(eq(workspaces.id, workspaceId))
      .run();

    return this.get(workspaceId);
  }

  /**
   * The readiness gate (§3.4): nothing runs in a workspace that is not ready.
   * Thrown as a refusal so the API reports the predicate's own visible reason
   * rather than inventing one.
   */
  requireReady(workspace: Workspace): void {
    const check = checkReady(workspace.readiness);
    if (!check.ready) {
      throw new WorkspaceRefused({
        reason: `workspace_${check.refusal.reason.replace(/-/gu, "_")}`,
        message: check.refusal.message,
      });
    }
  }
}

function toRow(workspace: Workspace): typeof workspaces.$inferInsert {
  return {
    id: workspace.id,
    workstreamId: workspace.workstreamId,
    kind: workspace.kind,
    configJson: JSON.stringify(workspace.config),
    rootsJson: JSON.stringify(workspace.roots),
    readinessJson: JSON.stringify(workspace.readiness),
    createdByKind: workspace.createdBy.kind,
    createdBySession:
      workspace.createdBy.kind === "session"
        ? workspace.createdBy.sessionId
        : null,
    createdAt: workspace.createdAt,
    provisionedAt: workspace.provisionedAt,
    provisionCostJson:
      workspace.provisionCost === null
        ? null
        : JSON.stringify(workspace.provisionCost),
    lastFingerprintJson:
      workspace.lastFingerprint === null
        ? null
        : JSON.stringify(workspace.lastFingerprint),
    removedAt: workspace.removedAt,
  };
}

export function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id as WorkspaceId,
    workstreamId: row.workstreamId as WorkstreamId,
    kind: row.kind,
    config: JSON.parse(row.configJson) as WorkspaceKindConfig,
    roots: JSON.parse(row.rootsJson) as readonly WorkspaceRoot[],
    readiness: JSON.parse(row.readinessJson) as ReadinessRecord,
    createdBy:
      row.createdByKind === "session"
        ? { kind: "session", sessionId: row.createdBySession as SessionId }
        : { kind: "human" },
    createdAt: row.createdAt,
    provisionedAt: row.provisionedAt,
    provisionCost:
      row.provisionCostJson === null
        ? null
        : (JSON.parse(row.provisionCostJson) as ProvisionCost),
    lastFingerprint:
      row.lastFingerprintJson === null
        ? null
        : (JSON.parse(row.lastFingerprintJson) as WorkspaceFingerprint),
    removedAt: row.removedAt,
  };
}
