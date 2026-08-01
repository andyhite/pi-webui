import type {
  AskPoint,
  CommandLifecycle,
  ContentBudget,
  ExpectedOutcome,
  ModelChoice,
  ParameterValue,
  ToolPermissions,
} from "./commands.js";
import type {
  CommandDefinitionId,
  CommandId,
  NodeId,
  ObjectId,
  RunId,
  VersionId,
} from "./ids.js";

/**
 * Spec §15 invariant 1: run history records the **full assembled content and
 * configuration**, not just versions. A history that recorded less leaves
 * every past run uncomparable forever (§3.7, §4.4).
 *
 * Both halves are non-optional in these types for the same reason they are
 * NOT NULL in the schema: a run that exists without them is the exact record
 * the invariant exists to prevent.
 */

/** One assembled input, in the exact order it was given to the agent (§3.5). */
export interface AssembledInput {
  /** 1-based assembly order, mirroring the context edge's ordinal. */
  readonly ordinal: number;
  readonly nodeId: NodeId | null;
  readonly objectId: ObjectId;
  /** The exact version consumed; retained for as long as the run is (§15-3). */
  readonly versionId: VersionId;
  readonly contentHash: string;
  readonly bytes: number;
}

/**
 * Everything about *how* the run was configured, captured at start. Reading
 * the definition again later answers a different question — definitions are
 * editable content, so a run must carry its own copy (§3.5, §4.4).
 */
export interface RunConfiguration {
  readonly definitionId: CommandDefinitionId;
  readonly definitionName: string;
  /** The instruction as it read at run time, not as it reads now. */
  readonly instruction: string;
  readonly model: ModelChoice;
  readonly permissions: ToolPermissions;
  /** Effective, so a run records what would actually have been asked (§6.6). */
  readonly askPoints: readonly AskPoint[];
  readonly lifecycle: CommandLifecycle;
  readonly outcome: ExpectedOutcome | null;
  /** Confirmed parameter values only; a proposal never reaches a run (§3.5). */
  readonly parameters: Readonly<Record<string, ParameterValue>>;
  readonly budget: ContentBudget;
}

/** What it cost, so "is delegating this working?" is answerable (§4.4, §8). */
export interface RunCost {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Millionths of a unit of currency: integer money, no float drift. */
  readonly costMicros: number;
}

export const ZERO_COST: RunCost = {
  inputTokens: 0,
  outputTokens: 0,
  costMicros: 0,
};

/**
 * A run's end state. Out-of-budget is its own outcome, distinct from failure:
 * PlotRoom stopped the work deliberately, and reporting that as a failure
 * makes every cross-run outcome dishonest (§3.6, §8).
 */
export const RUN_STATUSES = [
  "running",
  "completed",
  "failed",
  "out_of_budget",
  "stopped",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export interface Run {
  readonly id: RunId;
  readonly commandId: CommandId;
  /** Recorded on the run: retention is per definition (§4.4). */
  readonly definitionId: CommandDefinitionId;
  /** The `n` in `output@n`: 1-based, monotonic per command (§15-4). */
  readonly ordinal: number;
  readonly status: RunStatus;
  /** §15-1: the blob holding the exact bytes the agent was given. */
  readonly assembledBlobId: string;
  readonly assembledHash: string;
  readonly assembledBytes: number;
  readonly configuration: RunConfiguration;
  readonly inputs: readonly AssembledInput[];
  readonly cost: RunCost;
  /** Pinning is the human's word for "never compact this" (§4.4). */
  readonly pinned: boolean;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

/** One produced output of one run, addressable as `command/name@n` (§15-4). */
export interface RunOutput {
  readonly runId: RunId;
  readonly name: string;
  readonly objectId: ObjectId;
  readonly versionId: VersionId;
}

/**
 * Spec §4.4: run history has its own retention rule — the last N runs per
 * command *definition*, plus every pinned run and everything it references,
 * plus everything inside a configurable window.
 */
export interface RunRetentionPolicy {
  /** The N in "last N runs per definition". */
  readonly keepPerDefinition: number;
  /** Runs younger than this are kept regardless of rank. */
  readonly windowSeconds: number;
}

/**
 * Defaults, chosen deliberately rather than "forever" (principle 11, §12).
 * The window matches version compaction so the two rules cannot disagree about
 * how old "old" is.
 */
export const DEFAULT_RUN_RETENTION_POLICY: RunRetentionPolicy = {
  keepPerDefinition: 20,
  windowSeconds: 30 * 24 * 60 * 60,
};

/** What the rule reads. The caller supplies the ranking; the rule decides. */
export interface RunRetentionFacts {
  readonly pinned: boolean;
  readonly startedAt: number;
  /** 1-based rank among runs of the same definition, newest first. */
  readonly recencyRank: number;
  /** True for the newest run of its command, which `latest` resolves to. */
  readonly isLatestForCommand: boolean;
}

/**
 * The run-history retention predicate, kept as one pure function for the same
 * reason `isCompactable` is: the rule lives in one place and is asserted
 * directly, and the store mirrors it rather than restating it.
 *
 * A run is compactable only when it is unpinned, not the newest run of its
 * command (or `latest` would stop resolving), outside the last N for its
 * definition, and older than the window.
 */
export function isRunCompactable(
  run: RunRetentionFacts,
  context: { readonly now: number; readonly policy: RunRetentionPolicy },
): boolean {
  if (run.pinned) return false;
  if (run.isLatestForCommand) return false;
  if (run.recencyRank <= context.policy.keepPerDefinition) return false;
  return run.startedAt < context.now - context.policy.windowSeconds;
}
