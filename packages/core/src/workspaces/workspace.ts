import type { Author } from "../author.js";
import type { WorkstreamId } from "../ids.js";
import type { WorkspaceFingerprint } from "./divergence.js";
import type { EpochMillis } from "./exec.js";
import type { WorkspaceId } from "./ids.js";
import type {
  ProvisionCost,
  WorkspaceKindConfig,
  WorkspaceKindName,
} from "./kind.js";
import type { ReadinessRecord } from "./readiness.js";
import { initialReadiness } from "./readiness.js";

/**
 * The workspace record (§3.4) — the state shape the server persists (Phase 2,
 * Track A). This package owns the shape and the rules over it; storage does
 * not restate either.
 *
 * "One workstream owns exactly one workspace; workspaces never cross
 * workstreams." That boundary is guaranteed by the product, so it is a
 * predicate here rather than a promise each kind keeps: `checkWorkspaceBoundary`
 * is what the canvas, the API, and agent tools all call, and no kind is
 * consulted.
 */

/** One place work happens. Git has one; a composite kind (§13) has several. */
export interface WorkspaceRoot {
  /** Stable within a workspace; the join key for status and fingerprints. */
  readonly key: string;
  readonly path: string;
  /** The named line of work at provisioning time — a git branch. */
  readonly branch: string | null;
  /**
   * True when this root is the repository's own checkout rather than a
   * provisioned one. Protected from removal (§3.4).
   */
  readonly primaryCheckout: boolean;
}

export interface Workspace {
  readonly id: WorkspaceId;
  /** Exactly one workstream owns this, for the whole life of the record (§3.4). */
  readonly workstreamId: WorkstreamId;
  readonly kind: WorkspaceKindName;
  /** Opaque to the product; the kind validated it (§10.1). */
  readonly config: WorkspaceKindConfig;
  readonly roots: readonly WorkspaceRoot[];
  readonly readiness: ReadinessRecord;
  /** Who asked for this workspace to exist — a human or a session (principle 1). */
  readonly createdBy: Author;
  readonly createdAt: EpochMillis;
  readonly provisionedAt: EpochMillis | null;
  /** What provisioning cost, kept so the operator can see it after the fact (§3.4). */
  readonly provisionCost: ProvisionCost | null;
  /** The last observed fingerprint; divergence compares against a session's own. */
  readonly lastFingerprint: WorkspaceFingerprint | null;
  /** Soft removal, like every destructive operation on authored state (principle 10). */
  readonly removedAt: EpochMillis | null;
}

export interface NewWorkspace {
  readonly id: WorkspaceId;
  readonly workstreamId: WorkstreamId;
  readonly kind: WorkspaceKindName;
  readonly config: WorkspaceKindConfig;
  readonly createdBy: Author;
}

/**
 * A workspace record before any mechanism exists. Creating a workstream does
 * not provision anything: the record starts `unprovisioned` with no roots, and
 * the run path provisions at first run (§3.4, §3.5).
 */
export function newWorkspaceRecord(
  workspace: NewWorkspace,
  now: EpochMillis,
): Workspace {
  return {
    ...workspace,
    roots: [],
    readiness: initialReadiness(now),
    createdAt: now,
    provisionedAt: null,
    provisionCost: null,
    lastFingerprint: null,
    removedAt: null,
  };
}

export const BOUNDARY_REFUSAL_REASONS = [
  /** The workstream already owns a workspace; there is never a second (§3.4). */
  "workstream_has_workspace",
  /** Another workstream's live workspace already owns this path (§3.4). */
  "path_owned_by_other_workstream",
  /** Two roots of one workspace cannot be the same place. */
  "duplicate_root",
] as const;

export type BoundaryRefusalReason = (typeof BOUNDARY_REFUSAL_REASONS)[number];

export interface BoundaryRefusal {
  readonly reason: BoundaryRefusalReason;
  readonly message: string;
  /** The workstream already holding it, when that is what refused. */
  readonly heldBy: WorkstreamId | null;
}

export type BoundaryCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly refusal: BoundaryRefusal };

/**
 * The boundary rule. `existing` is every workspace the product knows about;
 * removed ones do not hold anything.
 */
export function checkWorkspaceBoundary(
  request: { readonly workstreamId: WorkstreamId },
  existing: readonly Workspace[],
): BoundaryCheck {
  const live = existing.filter((workspace) => workspace.removedAt === null);
  const held = live.find(
    (workspace) => workspace.workstreamId === request.workstreamId,
  );
  if (held !== undefined) {
    return {
      allowed: false,
      refusal: {
        reason: "workstream_has_workspace",
        message:
          "This workstream already owns a workspace; a workstream owns exactly one.",
        heldBy: request.workstreamId,
      },
    };
  }
  return { allowed: true };
}

/**
 * The same boundary at the moment roots become real: provisioning must not
 * hand a workstream a place another workstream is already working in, and one
 * workspace must not list the same place twice. Checked against provisioning
 * results, because that is when paths are known.
 */
export function checkRootOwnership(
  workspace: Pick<Workspace, "id" | "workstreamId">,
  roots: readonly WorkspaceRoot[],
  existing: readonly Workspace[],
): BoundaryCheck {
  const seen = new Set<string>();
  for (const root of roots) {
    const path = normalizePath(root.path);
    if (seen.has(path)) {
      return {
        allowed: false,
        refusal: {
          reason: "duplicate_root",
          message: `Two roots of this workspace point at the same path: ${root.path}`,
          heldBy: null,
        },
      };
    }
    seen.add(path);
  }

  for (const other of existing) {
    if (other.id === workspace.id) continue;
    if (other.removedAt !== null) continue;
    for (const otherRoot of other.roots) {
      const otherPath = normalizePath(otherRoot.path);
      if (!seen.has(otherPath)) continue;
      return {
        allowed: false,
        refusal: {
          reason: "path_owned_by_other_workstream",
          message: `${otherRoot.path} is already the workspace of another workstream; workspaces never cross workstreams.`,
          heldBy: other.workstreamId,
        },
      };
    }
  }

  return { allowed: true };
}

function normalizePath(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  return trimmed === "" ? "/" : trimmed;
}

export function workspaceRoot(
  workspace: Workspace,
  key: string,
): WorkspaceRoot | null {
  return workspace.roots.find((root) => root.key === key) ?? null;
}
