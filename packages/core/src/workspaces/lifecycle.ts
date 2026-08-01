import type { Author } from "../author.js";
import type { WorkstreamId } from "../ids.js";
import type { WorkspaceId } from "./ids.js";
import type {
  DiscoveredRepository,
  RemovalOptions,
  RemovalRefusal,
  WorkspaceKindConfig,
  WorkspaceKindName,
} from "./kind.js";
import type { BoundaryCheck, Workspace, WorkspaceRoot } from "./workspace.js";
import { checkRootOwnership, checkWorkspaceBoundary } from "./workspace.js";

/**
 * Workspace lifecycle (§3.4): create, attach, remove, force-remove — and the
 * line principle 6 draws between a repository being *available* and a workspace
 * being *placed*.
 *
 * "Configured search paths are scanned so repositories are found, not only
 * declared; a discovered repository is available but places nothing on the
 * canvas."
 *
 * Discovery in this package returns `DiscoveredRepository` values, which carry
 * no workspace id, no workstream, and no author — they cannot describe
 * themselves as placed. Turning one into a workspace goes through `attachRequest`
 * below, which cannot be built without a workstream and an author. There is no
 * path from a scan to a placed workspace that does not pass through a gesture.
 */

export interface CreateWorkspaceRequest {
  readonly workspaceId: WorkspaceId;
  readonly workstreamId: WorkstreamId;
  readonly kind: WorkspaceKindName;
  readonly config: WorkspaceKindConfig;
  /** Human or session; a workspace is authored like everything else (principle 1). */
  readonly author: Author;
}

export interface AttachWorkspaceRequest extends CreateWorkspaceRequest {
  /** The places that already exist and are being adopted rather than made. */
  readonly roots: readonly WorkspaceRoot[];
}

/**
 * The one way a discovered repository becomes a workspace request. The
 * workstream and the author are parameters, not inferences: a scan cannot
 * supply either, which is what stops discovery from placing anything.
 */
export function attachRequest(
  repository: DiscoveredRepository,
  target: {
    readonly workspaceId: WorkspaceId;
    readonly workstreamId: WorkstreamId;
    readonly author: Author;
    readonly config?: WorkspaceKindConfig;
  },
): AttachWorkspaceRequest {
  return {
    workspaceId: target.workspaceId,
    workstreamId: target.workstreamId,
    kind: repository.kind,
    config: target.config ?? { path: repository.path },
    author: target.author,
    roots: [
      {
        key: "root",
        path: repository.path,
        branch: repository.currentBranch,
        primaryCheckout: repository.primaryCheckout,
      },
    ],
  };
}

/** Creating: the boundary rule, before any mechanism is asked to do work. */
export function checkCreate(
  request: CreateWorkspaceRequest,
  existing: readonly Workspace[],
): BoundaryCheck {
  return checkWorkspaceBoundary(request, existing);
}

/** Attaching: the same boundary, plus the paths being adopted. */
export function checkAttach(
  request: AttachWorkspaceRequest,
  existing: readonly Workspace[],
): BoundaryCheck {
  const boundary = checkWorkspaceBoundary(request, existing);
  if (!boundary.allowed) return boundary;
  return checkRootOwnership(
    { id: request.workspaceId, workstreamId: request.workstreamId },
    request.roots,
    existing,
  );
}

/** What removal has to be decided against, gathered from live status (§3.4). */
export interface RemovalTarget {
  readonly root: WorkspaceRoot;
  /** The branch the checkout is on right now, read live — not the record's belief. */
  readonly currentBranch: string | null;
  /** The repository's default branch, which is protected. */
  readonly defaultBranch: string | null;
  readonly uncommittedCount: number;
}

export type RemovalCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly refusal: RemovalRefusal };

/**
 * "Workspaces can be created, attached, removed, and force-removed when
 * uncommitted changes exist. The primary checkout and the default branch are
 * protected and never removable."
 *
 * Force is scoped to exactly one refusal — uncommitted work. The two
 * protections report `forcible: false` and are refused with `force` set, which
 * is what makes "never removable" true rather than advisory.
 */
export function checkRemoval(
  target: RemovalTarget,
  options: RemovalOptions,
): RemovalCheck {
  if (target.root.primaryCheckout) {
    return {
      allowed: false,
      refusal: {
        reason: "primary_checkout",
        message: `${target.root.path} is the repository's primary checkout; it is protected and never removable.`,
        forcible: false,
      },
    };
  }

  if (
    target.currentBranch !== null &&
    target.defaultBranch !== null &&
    target.currentBranch === target.defaultBranch
  ) {
    return {
      allowed: false,
      refusal: {
        reason: "default_branch",
        message: `${target.root.path} is on the default branch (${target.defaultBranch}); it is protected and never removable.`,
        forcible: false,
      },
    };
  }

  if (target.uncommittedCount > 0 && !options.force) {
    return {
      allowed: false,
      refusal: {
        reason: "uncommitted_changes",
        message: `${target.root.path} has ${target.uncommittedCount} uncommitted change(s). Force-remove to discard them.`,
        forcible: true,
      },
    };
  }

  return { allowed: true };
}
