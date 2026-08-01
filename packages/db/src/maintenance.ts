import { and, isNotNull, isNull, sql } from "drizzle-orm";
import {
  initialReadiness,
  systemClock,
  type Workspace,
  DEFAULT_COMPACTION_POLICY,
  DEFAULT_RUN_RETENTION_POLICY,
  type Clock,
  type CompactionPolicy,
  type RunRetentionPolicy,
} from "@plotroom/core";
import { BlobStore } from "./blob-store.js";
import type { PlotroomDatabase } from "./client.js";
import { GraphStore } from "./graph-store.js";
import { ObjectStore } from "./object-store.js";
import { RunStore } from "./run-store.js";
import { SCHEMA_VERSION } from "./client.js";
import { toWorkspace } from "./workspace-store.js";
import {
  blobRefs,
  blobs,
  commandDefinitions,
  commandOutputs,
  commandParameterBindings,
  commands,
  edges,
  nodes,
  objectVersions,
  objects,
  runInitiations,
  runInputs,
  runOutputs,
  runSubmissions,
  runs,
  sessionInjections,
  sessionLineage,
  sessionObservations,
  sessionTranscriptPublications,
  sessions,
  workspaces,
  workstreamEvents,
  workstreams,
} from "./schema.js";

/**
 * Durability and portability (spec §12, Epic 2.3).
 *
 * "All state in the single portable store; survives restart; backup/move story."
 * That claim is only as good as its inventory, so this module is where the
 * inventory lives: what is in the store, what a reset would remove, and the
 * compaction sweep that keeps the store from growing forever.
 *
 * Two rules shape everything here:
 *
 * - **Nothing is removed without saying what it is first.** Every verb has a
 *   plan (`resetPlan`) that states counts and names, and the executing verb
 *   returns what it actually removed. A cleanup that surprises you is a data
 *   loss bug with a friendly name (§12, principle 12).
 * - **Compaction removes only what nothing points at.** The rules are the pure
 *   predicates in `@plotroom/core` (`isCompactable`, `isRunCompactable`), applied
 *   by the stores that own those rows; this only sequences them and then sweeps
 *   the blobs left unreferenced (§15-3).
 */

/** Everything the store holds, for the backup and reset stories (§12). */
export interface StateInventory {
  readonly schemaVersion: number;
  readonly stateDir: string;
  readonly databaseFile: string;
  readonly blobsDir: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly blobBytes: {
    readonly inline: number;
    readonly external: number;
  };
  /** Nodes with an authored position — what "reset arrangement" would clear. */
  readonly arrangedNodes: number;
  /** Workspaces whose mechanism exists on disk — derived, re-provisionable. */
  readonly provisionedWorkspaces: number;
}

export const RESET_SCOPES = ["arrangement", "derived", "everything"] as const;

export type ResetScope = (typeof RESET_SCOPES)[number];

/** What a reset would remove, stated before anything is removed (§12). */
export interface ResetPlan {
  readonly scope: ResetScope;
  /** One line per thing that will go, in the operator's words. */
  readonly removes: readonly string[];
  /** What is deliberately kept, so the answer is not half a sentence. */
  readonly keeps: readonly string[];
  /** Machine-readable counts behind the lines above. */
  readonly counts: Readonly<Record<string, number>>;
}

export interface ResetResult {
  readonly scope: ResetScope;
  readonly removed: Readonly<Record<string, number>>;
}

export interface CompactionPolicies {
  readonly versions?: CompactionPolicy;
  readonly runs?: RunRetentionPolicy;
}

export interface CompactionResult {
  readonly at: number;
  readonly versionsRemoved: number;
  readonly runsRemoved: number;
  readonly blobsRemoved: number;
  readonly bytesFreed: number;
}

/**
 * The order children are emptied in, so a full reset never trips a foreign key.
 * Written out rather than inferred, because the order *is* the dependency graph
 * and an inferred one would quietly change when a table is added.
 */
const CLEAR_ORDER = [
  ["run_initiations", runInitiations],
  ["run_submissions", runSubmissions],
  ["session_injections", sessionInjections],
  ["session_transcript_publications", sessionTranscriptPublications],
  ["session_observations", sessionObservations],
  ["sessions", sessions],
  ["run_outputs", runOutputs],
  ["run_inputs", runInputs],
  ["runs", runs],
  ["command_outputs", commandOutputs],
  ["command_parameter_bindings", commandParameterBindings],
  ["commands", commands],
  ["command_definitions", commandDefinitions],
  ["workspaces", workspaces],
  ["workstream_events", workstreamEvents],
  ["workstreams", workstreams],
  ["edges", edges],
  ["nodes", nodes],
  ["session_lineage", sessionLineage],
  ["object_versions", objectVersions],
  ["objects", objects],
  ["blob_refs", blobRefs],
] as const;

/**
 * Said in both scopes that delete a checkout, in one wording so the two cannot
 * drift apart. Git makes a workspace cheap to recreate, not lossless to delete:
 * uncommitted work and unpushed commits exist nowhere else.
 */
export const WORKSPACE_DESTRUCTION_WARNING =
  "anything inside those checkouts that is not committed and pushed is destroyed with them — uncommitted changes, untracked files, and commits that only exist locally";

export class Maintenance {
  private readonly blobStore: BlobStore;
  private readonly graph: GraphStore;
  private readonly objectStore: ObjectStore;
  private readonly runStore: RunStore;

  constructor(
    private readonly state: PlotroomDatabase,
    private readonly now: Clock = systemClock,
  ) {
    this.blobStore = new BlobStore(state, now);
    this.graph = new GraphStore(state, now);
    this.objectStore = new ObjectStore(state, now);
    this.runStore = new RunStore(state, now);
  }

  /**
   * What the store holds. The paths are in the answer on purpose: "back up the
   * state directory" is only actionable if the product will say which directory
   * that is (§12).
   */
  inventory(): StateInventory {
    const counts: Record<string, number> = {};
    for (const [name, table] of CLEAR_ORDER) {
      counts[name] = this.count(table);
    }

    const bytes = this.state.db
      .select({
        inline: sql<number>`COALESCE(SUM(CASE WHEN ${blobs.isExternal} = 0 THEN ${blobs.size} ELSE 0 END), 0)`,
        external: sql<number>`COALESCE(SUM(CASE WHEN ${blobs.isExternal} = 1 THEN ${blobs.size} ELSE 0 END), 0)`,
      })
      .from(blobs)
      .get();

    return {
      schemaVersion: SCHEMA_VERSION,
      stateDir: this.state.layout.dir,
      databaseFile: this.state.layout.databaseFile,
      blobsDir: this.state.layout.blobsDir,
      counts: { ...counts, blobs: this.count(blobs) },
      blobBytes: { inline: bytes?.inline ?? 0, external: bytes?.external ?? 0 },
      arrangedNodes: this.arrangedNodes(),
      provisionedWorkspaces: this.provisionedWorkspaces(),
    };
  }

  /**
   * State the removal before making it (§12). The plan and the execution read
   * the same counts, so what the operator confirmed is what happens — a plan
   * computed differently from the deletion is a confirmation of nothing.
   */
  resetPlan(scope: ResetScope): ResetPlan {
    switch (scope) {
      case "arrangement": {
        const arranged = this.arrangedNodes();
        return {
          scope,
          removes: [
            `the authored position of ${arranged} ${arranged === 1 ? "node" : "nodes"} — the board is laid out again from scratch`,
          ],
          keeps: [
            "every node, edge, object, command, run, and session; only where things sit is forgotten",
          ],
          counts: { arrangedNodes: arranged },
        };
      }

      case "derived": {
        const provisioned = this.provisionedWorkspaces();
        return {
          scope,
          removes: [
            `${provisioned} provisioned ${provisioned === 1 ? "workspace" : "workspaces"} — the checkouts on disk are deleted and provisioned again at the next run`,
            // "Re-provisioned" is only lossless for what git already has
            // somewhere else. Anything uncommitted, or committed but never
            // pushed, is inside that checkout and goes with it — said plainly,
            // because a cleanup verb that reads as harmless is a data-loss bug
            // with a friendly name (§12, principle 12).
            WORKSPACE_DESTRUCTION_WARNING,
            "the shared git mirror cache, which makes the next provisioning slower but not different",
          ],
          keeps: [
            "every workspace record, so each workstream still owns exactly one",
            "run history, sessions, and their observation logs — none of it is derived",
            "the search index and session phase snapshots, which are derivable but have no rebuild step yet, so removing them would lose more than it reclaims",
          ],
          counts: { provisionedWorkspaces: provisioned },
        };
      }

      case "everything": {
        const counts: Record<string, number> = {};
        for (const [name, table] of CLEAR_ORDER) {
          counts[name] = this.count(table);
        }
        counts["blobs"] = this.count(blobs);

        const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
        const live = this.liveSessions();

        return {
          scope,
          removes: [
            ...(live > 0
              ? [
                  `${live} ${live === 1 ? "session" : "sessions"} still in flight \u2014 their records go, and their runtimes are not asked to stop first`,
                ]
              : []),
            `every row in the store: ${total} in total, including ${counts["runs"]} runs, ${counts["sessions"]} sessions, ${counts["objects"]} objects, and ${counts["workstreams"]} workstreams`,
            `${counts["blobs"]} stored blobs, inline and external alike — the content itself`,
            "every provisioned workspace's checkout and the shared git cache",
            WORKSPACE_DESTRUCTION_WARNING,
          ],
          keeps: [
            "the schema: the store is emptied, not deleted, so the app starts clean rather than broken",
          ],
          counts: { ...counts, liveSessions: live },
        };
      }
    }
  }

  /**
   * Empty the rows a scope names. Directories on disk are the server's half of
   * this (it owns the paths); this owns the store, and the two are reported
   * together so the operator sees one answer.
   */
  reset(scope: ResetScope): ResetResult {
    if (scope === "arrangement") {
      const { cleared } = this.graph.clearPositions();
      return { scope, removed: { arrangedNodes: cleared } };
    }

    if (scope === "derived") {
      // The records stay: a workstream still owns exactly one workspace (§3.4).
      // What goes is the mechanism, which the next run rebuilds.
      const reverted = this.state.db
        .update(workspaces)
        .set({
          rootsJson: "[]",
          provisionedAt: null,
          provisionCostJson: null,
          lastFingerprintJson: null,
          // The record shape is `@plotroom/core`'s, so it is asked for rather
          // than restated here: a second spelling of "unprovisioned" is a second
          // thing to keep in step.
          readinessJson: JSON.stringify(initialReadiness(this.now() * 1000)),
        })
        .where(isNotNull(workspaces.provisionedAt))
        .run();

      return { scope, removed: { provisionedWorkspaces: reverted.changes } };
    }

    const removed: Record<string, number> = {};

    this.state.db.transaction(() => {
      for (const [name, table] of CLEAR_ORDER) {
        removed[name] = this.state.db.delete(table).run().changes;
      }
      this.state.sqlite.prepare("DELETE FROM search").run();
    });

    // Blobs go last and through the blob store, so the external files go with
    // the rows rather than being left orphaned on disk.
    const swept = this.blobStore.compact();
    removed["blobs"] = swept.removed;
    removed["bytesFreed"] = swept.bytesFreed;

    return { scope: "everything", removed };
  }

  /**
   * The compaction sweep (§15-3, §4.4): runs first, then versions, then the
   * blobs nothing points at any more.
   *
   * The order matters and is not arbitrary, and it reads backwards from what it
   * reclaims: run compaction is what releases the `run_referenced` flag from
   * versions, so it comes first or the versions it freed would survive another
   * whole interval; version compaction is what drops blob references, so it
   * comes before the blob sweep for the same reason. Blobs are last, when the
   * graph of references has finished shrinking. Nothing here decides *what* is
   * compactable: the pure predicates do, and pinned or referenced content is
   * never a candidate.
   */
  compact(policies: CompactionPolicies = {}): CompactionResult {
    const runsRemoved = this.runStore.compactRuns(
      policies.runs ?? DEFAULT_RUN_RETENTION_POLICY,
    ).removed;

    const versionsRemoved = this.objectStore.compactVersions(
      policies.versions ?? DEFAULT_COMPACTION_POLICY,
    ).removed;

    const swept = this.blobStore.compact();

    return {
      at: this.now(),
      versionsRemoved,
      runsRemoved,
      blobsRemoved: swept.removed,
      bytesFreed: swept.bytesFreed,
    };
  }

  private arrangedNodes(): number {
    const row = this.state.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(nodes)
      .where(and(isNotNull(nodes.x), isNotNull(nodes.y)))
      .get();
    return row?.count ?? 0;
  }

  /**
   * The workspace records whose mechanism exists on disk — what a `derived` or
   * `everything` reset would delete or forget.
   *
   * Public because the *plan* needs them: whether a checkout is holding
   * uncommitted work is a question only the workspace kind can answer, and the
   * kind registry is the server's (§10.1). This hands over the records; nothing
   * here asks git anything.
   */
  provisionedWorkspaceRecords(): Workspace[] {
    return this.state.db
      .select()
      .from(workspaces)
      .where(
        and(isNull(workspaces.removedAt), isNotNull(workspaces.provisionedAt)),
      )
      .all()
      .map((row) => toWorkspace(row));
  }

  /** Sessions with no end recorded — work a reset would delete out from under. */
  private liveSessions(): number {
    const row = this.state.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(sessions)
      .where(isNull(sessions.endKind))
      .get();
    return row?.count ?? 0;
  }

  private provisionedWorkspaces(): number {
    const row = this.state.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(workspaces)
      .where(isNotNull(workspaces.provisionedAt))
      .get();
    return row?.count ?? 0;
  }

  private count(table: (typeof CLEAR_ORDER)[number][1] | typeof blobs): number {
    const row = this.state.db
      .select({ count: sql<number>`COUNT(*)` })
      .from(table)
      .get();
    return row?.count ?? 0;
  }
}
