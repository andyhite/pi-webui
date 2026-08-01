import type { WorkspaceFingerprint } from "./divergence.js";
import type { EpochMillis } from "./exec.js";
import type { WorkspaceId } from "./ids.js";
import type { ResolvedSetup, SetupAttempt } from "./readiness.js";
import type { Workspace, WorkspaceRoot } from "./workspace.js";

/**
 * The workspace-kind contract (§3.4, §10.1).
 *
 * "One workstream owns exactly one workspace; workspaces never cross
 * workstreams. The *boundary* is guaranteed by the product; the *mechanism* is
 * supplied per workspace kind."
 *
 * The boundary lives in `workspace.ts` as a predicate over records — no kind
 * can weaken it, because no kind is asked about it. This file is only the
 * mechanism: provisioning, readiness execution, live status, fingerprinting for
 * divergence, discovery, and removal.
 *
 * Two things are deliberately shaped for kinds that do not exist yet:
 *
 * - **Multi-root (§13).** Status, fingerprints, and provisioning results are
 *   lists of *units*, one per root. A composite kind spanning a frontend and a
 *   backend reports two; git reports one. The concept already exists, so a
 *   composite kind needs no new one.
 * - **Plugin-supplied kinds (§10.1).** Configuration is a JSON record the kind
 *   validates itself, because a plugin kind runs behind a worker boundary its
 *   config crosses as JSON. A kind refuses bad configuration with a reason; it
 *   never throws its way out of the product.
 */

export type WorkspaceKindName = string;

export const GIT_WORKSPACE_KIND: WorkspaceKindName = "git";

/** Opaque to the product, owned by the kind, JSON because plugins are out of process. */
export type WorkspaceKindConfig = Readonly<Record<string, unknown>>;

export interface WorkspaceConfigRefusal {
  readonly reason: "invalid_config";
  readonly message: string;
  /** Which configuration fields were wrong, so the UI can point at them. */
  readonly fields: readonly string[];
}

export type WorkspaceConfigCheck =
  | { readonly valid: true }
  | { readonly valid: false; readonly refusal: WorkspaceConfigRefusal };

/**
 * What provisioning cost (§3.4). Reported per provisioning, stored on the
 * record, and shown to the operator: "provisioning per unit of work is
 * expensive in time and disk". Unknown disk usage is null, never zero.
 */
export interface ProvisionCost {
  readonly elapsedMillis: number;
  readonly bytesOnDisk: number | null;
  /** How the kind reused shared storage, if it could at all. */
  readonly sharedCache: "hit" | "miss" | "unavailable";
  /** The mechanism actually used, e.g. "worktree" or "clone". */
  readonly strategy: string;
}

export interface ProvisionRequest {
  readonly workspaceId: WorkspaceId;
  readonly kind: WorkspaceKindName;
  readonly config: WorkspaceKindConfig;
  readonly requestedAt: EpochMillis;
}

export const PROVISION_FAILURE_REASONS = [
  "invalid_config",
  /** The host's own git/SSH configuration could not authenticate (§3.4, §9.3). */
  "host_auth",
  /** The target path is occupied by something the product will not overwrite. */
  "occupied",
  /** The mechanism reported an error; `message` carries it verbatim. */
  "mechanism_failed",
] as const;

export type ProvisionFailureReason = (typeof PROVISION_FAILURE_REASONS)[number];

export interface ProvisionFailure {
  readonly reason: ProvisionFailureReason;
  /** The honest reason, including the mechanism's own error text (§3.4). */
  readonly message: string;
  /** What ran, in order, so a failed provisioning is inspectable. */
  readonly log: readonly string[];
}

export type ProvisionOutcome =
  | {
      readonly provisioned: true;
      readonly roots: readonly WorkspaceRoot[];
      readonly cost: ProvisionCost;
      readonly log: readonly string[];
      /**
       * What the kind found rather than made — a branch that already existed is
       * taken as it is, never renamed or re-derived (§3.4).
       */
      readonly notes: readonly string[];
    }
  | { readonly provisioned: false; readonly failure: ProvisionFailure };

/**
 * Live status (§3.4): "current branch, uncommitted changes, ahead/behind — kept
 * current so a change made by any session *or by a terminal* is reflected
 * everywhere it is shown". Every field here is read from the mechanism at the
 * moment it is asked for; nothing in this package caches it.
 */
export interface WorkspaceUnitStatus {
  readonly rootKey: string;
  readonly path: string;
  /** Null for a kind with no branches, or for a detached checkout. */
  readonly branch: string | null;
  readonly head: string | null;
  readonly detached: boolean;
  readonly upstream: string | null;
  readonly ahead: number | null;
  readonly behind: number | null;
  /** Every changed path, complete — the product never silently truncates. */
  readonly uncommitted: readonly string[];
  readonly untracked: readonly string[];
}

export interface WorkspaceStatus {
  readonly workspaceId: WorkspaceId;
  readonly kind: WorkspaceKindName;
  readonly observedAt: EpochMillis;
  readonly units: readonly WorkspaceUnitStatus[];
  /** Set when the mechanism could not be read at all; status is never faked. */
  readonly unavailable: string | null;
}

export const REMOVAL_REFUSAL_REASONS = [
  /** The primary checkout is protected and never removable (§3.4). */
  "primary_checkout",
  /** The default branch is protected and never removable (§3.4). */
  "default_branch",
  /** Uncommitted work would be lost; force-remove is the explicit override (§3.4). */
  "uncommitted_changes",
  "mechanism_failed",
] as const;

export type RemovalRefusalReason = (typeof REMOVAL_REFUSAL_REASONS)[number];

export interface RemovalRefusal {
  readonly reason: RemovalRefusalReason;
  readonly message: string;
  /** Whether force-removal would get past this refusal. Protections say false. */
  readonly forcible: boolean;
}

export type RemovalOutcome =
  | { readonly removed: true; readonly log: readonly string[] }
  | { readonly removed: false; readonly refusal: RemovalRefusal };

export interface RemovalOptions {
  readonly force: boolean;
}

/**
 * A repository the product knows about but has placed nowhere (principle 6).
 * There is no node id, no workspace id, and no placement flag on this type: a
 * discovered repository cannot describe itself as present on the canvas,
 * because discovery makes things *available* and a gesture makes them present.
 */
export interface DiscoveredRepository {
  readonly kind: WorkspaceKindName;
  readonly path: string;
  readonly name: string;
  readonly defaultBranch: string | null;
  readonly currentBranch: string | null;
  readonly remotes: readonly { readonly name: string; readonly url: string }[];
  /** True for the repository's own checkout; protected from removal (§3.4). */
  readonly primaryCheckout: boolean;
}

export interface DiscoveryRequest {
  readonly searchPaths: readonly string[];
  /** How deep to descend below each search path; a scan is bounded, not endless. */
  readonly maxDepth: number;
}

export interface DiscoveryResult {
  readonly repositories: readonly DiscoveredRepository[];
  /** Paths that could not be read, reported rather than dropped. */
  readonly unreadable: readonly string[];
}

/**
 * One workspace mechanism. Everything is async because every method talks to a
 * machine; nothing is optional except discovery, which a kind with nothing to
 * scan for legitimately lacks.
 */
export interface WorkspaceKind {
  readonly name: WorkspaceKindName;

  /** Validate configuration before anything is created. */
  checkConfig(config: WorkspaceKindConfig): WorkspaceConfigCheck;

  /**
   * Create the mechanism. Called at first run, never at workstream creation
   * (§3.4, §3.5) — the run path calls this, which is why it is an explicit
   * operation rather than a side effect of anything.
   */
  provision(request: ProvisionRequest): Promise<ProvisionOutcome>;

  /** Run the declared setup step. The gate that consumes it is core's. */
  runSetup(
    workspace: Workspace,
    setup: ResolvedSetup,
    startedAt: EpochMillis,
  ): Promise<SetupAttempt>;

  /** Read live status from the mechanism — never from a cached belief (§3.4). */
  status(workspace: Workspace): Promise<WorkspaceStatus>;

  /** The comparable snapshot divergence detection works over (§3.4, §4.3). */
  fingerprint(workspace: Workspace): Promise<WorkspaceFingerprint>;

  /**
   * Whether a recorded head is still reachable per root, so `deriveDivergence`
   * can tell a rebase from new commits.
   */
  probeAncestry(
    workspace: Workspace,
    priorHeads: ReadonlyMap<string, string>,
  ): Promise<ReadonlyMap<string, boolean>>;

  remove(
    workspace: Workspace,
    options: RemovalOptions,
  ): Promise<RemovalOutcome>;

  discover?(request: DiscoveryRequest): Promise<DiscoveryResult>;
}

/**
 * The registry the server and the plugin host both go through. An unknown kind
 * is refused with a reason — a workspace whose kind's plugin is unavailable is
 * reported as unavailable, never guessed at (§10.2).
 */
export class WorkspaceKindRegistry {
  readonly #kinds = new Map<WorkspaceKindName, WorkspaceKind>();

  register(kind: WorkspaceKind): void {
    this.#kinds.set(kind.name, kind);
  }

  unregister(name: WorkspaceKindName): void {
    this.#kinds.delete(name);
  }

  names(): readonly WorkspaceKindName[] {
    return [...this.#kinds.keys()];
  }

  get(name: WorkspaceKindName): WorkspaceKind | null {
    return this.#kinds.get(name) ?? null;
  }

  require(name: WorkspaceKindName): WorkspaceKindLookup {
    const kind = this.#kinds.get(name);
    if (kind === undefined) {
      return {
        available: false,
        refusal: {
          reason: "unknown_kind",
          message: `No workspace kind named "${name}" is available.`,
        },
      };
    }
    return { available: true, kind };
  }
}

export type WorkspaceKindLookup =
  | { readonly available: true; readonly kind: WorkspaceKind }
  | {
      readonly available: false;
      readonly refusal: {
        readonly reason: "unknown_kind";
        readonly message: string;
      };
    };
