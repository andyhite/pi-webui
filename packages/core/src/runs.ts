import type { Author } from "./author.js";
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
  SessionId,
  VersionId,
  WorkstreamId,
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
 * A run's end state, mirroring the session end-state taxonomy (§3.6, §8).
 * Out-of-budget is its own outcome, distinct from failure — PlotRoom stopped the
 * work deliberately, and reporting that as a failure makes every cross-run
 * outcome dishonest — and so is interruption, which nobody chose at all.
 */
export const RUN_STATUSES = [
  "running",
  "completed",
  "failed",
  "out_of_budget",
  "stopped",
  /**
   * A crash or restart caught the run in flight (principle 11). Not stopped —
   * nobody decided to stop it — and not failed. The session that executed it
   * carries the same distinction (§3.6), and now so does its run history.
   */
  "interrupted",
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
  /**
   * The spend cap the operator accepted before this ran (§4.1, §8), or null when
   * none was accepted. Recorded beside what it actually cost, because an
   * estimate nobody wrote down cannot be compared with the bill afterwards.
   * Enforcing a cap is Phase 6's job; recording what was agreed is not.
   */
  readonly spendCapMicros: number | null;
  /** Pinning is the human's word for "never compact this" (§4.4). */
  readonly pinned: boolean;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

/* ---------------------------------------------------------------- assembly */

/** One assembled section, with the title and content the agent is given (§3.5). */
export interface AssembledSection {
  readonly title: string;
  readonly content: string;
}

/** One confirmed parameter value, as the run delivers it (§3.5). */
export interface AssembledParameter {
  readonly name: string;
  /** The definition's own wording for it, shown when it says more than the name. */
  readonly label: string;
  readonly value: ParameterValue;
}

/**
 * The bytes a run hands the runtime, assembled in one place (§15-1).
 *
 * The definition's **instruction comes first** — ahead of the workstream's
 * standing instructions and ahead of every wired input — because it is not one
 * input among the ticket and the diff: it is the frame the whole assembly
 * serves. Everything after it is material the task is carried out against,
 * which is the same argument §3.8 makes for standing instructions preceding the
 * wired inputs, one level further in.
 *
 * Confirmed parameter values travel with it because they are part of the same
 * sentence: a definition that says "review the diff against the standard" and
 * delivers no `standard` has delivered a different instruction. A proposal never
 * reaches here — `resolveParameters` is what refuses that (§3.5).
 *
 * This is the one description of what a run's assembled content is. The preview
 * shows it, `RunStore.start` records it, and the runtime is handed it, so none of
 * the three can disagree about what ran (§4.1).
 */
export function assembleRunBody(input: {
  readonly instruction: string;
  readonly parameters?: readonly AssembledParameter[];
  readonly inputs: readonly AssembledSection[];
}): string {
  const sections: string[] = [];

  const frame = instructionSection(input.instruction, input.parameters ?? []);
  if (frame !== null) sections.push(frame);

  for (const part of input.inputs) {
    sections.push(`## ${part.title}\n\n${part.content}`);
  }

  return sections.join("\n\n");
}

/**
 * `# Instruction` at one level above the inputs' `##`, so the frame is
 * structurally what it is rather than a section the agent may read as the first
 * of several.
 *
 * An empty instruction is representable — the column is only NOT NULL — and an
 * empty heading records it worse than no heading does: nothing is being dropped,
 * there was nothing there (principle 12 is about silent truncation, not about
 * inventing a section for absent content).
 */
function instructionSection(
  instruction: string,
  parameters: readonly AssembledParameter[],
): string | null {
  const trimmed = instruction.trim();
  if (trimmed === "" && parameters.length === 0) return null;

  const blocks = ["# Instruction"];
  if (trimmed !== "") blocks.push(trimmed);

  if (parameters.length > 0) {
    blocks.push(`Parameters:\n\n${parameters.map(parameterLine).join("\n")}`);
  }

  return blocks.join("\n\n");
}

/**
 * One parameter as one list item — including when its value is not one line.
 *
 * Nothing constrains a `text` value to a single line, and interpolating a
 * multi-line one straight after the colon would turn one parameter into several
 * list items, or into a heading sibling to the wired inputs' `##` sections. The
 * continuation is indented instead, which keeps the list structurally what it
 * says it is without editing the value the operator confirmed.
 */
function parameterLine(parameter: AssembledParameter): string {
  const named =
    parameter.label === "" || parameter.label === parameter.name
      ? `**${parameter.name}**`
      : `**${parameter.name}** (${parameter.label})`;
  const value = String(parameter.value);

  if (!value.includes("\n")) return `- ${named}: ${value}`;

  const indented = value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  return `- ${named}:\n${indented}`;
}

/* --------------------------------------------------------- cost estimation */

/**
 * Cost estimation for the run preview (§4.1).
 *
 * "Estimates state their basis and render as ranges — 'based on N prior runs' /
 * 'no history; input size only' — never a bare number."
 *
 * That sentence is the whole design. A bare number invites the reader to treat
 * a guess as a quote, so this type cannot express one: there is no single
 * figure, the basis is not optional, and the range is allowed to be absent
 * entirely — which is what honesty looks like when nothing has ever been priced
 * (principle 7: report what was observed, never infer past it).
 */
export const COST_ESTIMATE_BASES = [
  /** Priced from this definition's own run history — the only real evidence. */
  "prior-runs",
  /**
   * No priced history: the size of what will be sent is all that is known, so
   * that is all that is reported. No money figure is invented from it.
   */
  "input-size-only",
] as const;

export type CostEstimateBasis = (typeof COST_ESTIMATE_BASES)[number];

/** What one prior run of the same definition cost, as history recorded it. */
export interface PriorRunCost {
  readonly costMicros: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface CostRange {
  /** Cheapest prior run of this definition, in micros. */
  readonly lowMicros: number;
  readonly highMicros: number;
  /** The middle of the observed range, for a surface that wants one line. */
  readonly medianMicros: number;
}

export interface CostEstimate {
  readonly basis: CostEstimateBasis;
  /** How many priced runs the range came from; 0 for input-size-only. */
  readonly priorRuns: number;
  /**
   * Null exactly when nothing could be priced. A caller cannot accidentally
   * render a zero: there is no number to render.
   */
  readonly range: CostRange | null;
  /** What assembly will send, which is known either way (§3.5). */
  readonly inputTokens: number;
  /** The sentence a surface shows, stating the basis in words (§4.1). */
  readonly description: string;
}

/**
 * Estimate from history where there is history, and refuse to invent one where
 * there is not.
 *
 * Only runs that actually recorded a cost count: a run whose runtime reported no
 * cost contributes no evidence about money, and averaging a zero into the range
 * would quietly halve the estimate. `§15-1` is what makes this possible at all —
 * the history holds what each past run really consumed.
 */
export function estimateRunCost(input: {
  readonly inputTokens: number;
  readonly priorRuns: readonly PriorRunCost[];
}): CostEstimate {
  const priced = input.priorRuns
    .filter((run) => run.costMicros > 0)
    .map((run) => run.costMicros)
    .sort((a, b) => a - b);

  if (priced.length === 0) {
    return {
      basis: "input-size-only",
      priorRuns: 0,
      range: null,
      inputTokens: input.inputTokens,
      description: `no priced history for this definition; input size only (about ${input.inputTokens} tokens in)`,
    };
  }

  const lowMicros = priced[0] as number;
  const highMicros = priced[priced.length - 1] as number;
  const middle = Math.floor(priced.length / 2);
  const medianMicros =
    priced.length % 2 === 1
      ? (priced[middle] as number)
      : Math.round(
          ((priced[middle - 1] as number) + (priced[middle] as number)) / 2,
        );

  return {
    basis: "prior-runs",
    priorRuns: priced.length,
    range: { lowMicros, highMicros, medianMicros },
    inputTokens: input.inputTokens,
    description: `${formatMicros(lowMicros)}–${formatMicros(highMicros)} based on ${priced.length} prior ${
      priced.length === 1 ? "run" : "runs"
    } of this definition`,
  };
}

/**
 * Money as text, from integer micros. Kept beside the estimate so no surface
 * invents its own rounding and makes two screens disagree about the same run.
 */
export function formatMicros(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(micros >= 10_000 ? 2 : 4)}`;
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
  /**
   * True when an `output@latest` address currently resolves to this run.
   * Retention must never make a live address stop answering.
   */
  readonly addressedByLatest: boolean;
}

/**
 * The run-history retention predicate, kept as one pure function for the same
 * reason `isCompactable` is: the rule lives in one place and is asserted
 * directly, and the store mirrors it rather than restating it.
 *
 * A run is compactable only when it is unpinned, not the run `latest`
 * currently resolves to, outside the last N for its definition, and older
 * than the window.
 */
export function isRunCompactable(
  run: RunRetentionFacts,
  context: { readonly now: number; readonly policy: RunRetentionPolicy },
): boolean {
  if (run.pinned) return false;
  if (run.addressedByLatest) return false;
  if (run.recencyRank <= context.policy.keepPerDefinition) return false;
  return run.startedAt < context.now - context.policy.windowSeconds;
}

/* ------------------------------------------- scoped runs and the queue (§4.1) */

/**
 * "One initiation may cover" (§4.1). Every scope below is one human or session
 * gesture over many commands, and the product never adds a fifth of its own:
 * there is no scope meaning "whatever looks ready", because that would be the
 * system deciding what to run (principle 2).
 */
export const RUN_SCOPE_KINDS = [
  /** This command. */
  "one",
  /** This plus everything downstream that becomes runnable, in dependency order. */
  "subgraph",
  /** The upstream chain that would unblock a blocked command, then the command. */
  "missing",
  /** Everything drifted inside one workstream. */
  "drifted-workstream",
  /** Everything drifted, fleet-wide. */
  "drifted-fleet",
] as const;

export type RunScopeKind = (typeof RUN_SCOPE_KINDS)[number];

export type RunBatchState =
  | "running"
  /** A failed or out-of-budget session; resumable once the human addresses it. */
  | "paused"
  /** A user stop: "stopped means stopped", so the remainder never resumes. */
  | "aborted"
  | "completed";

/** One scoped gesture, as a record (§4.1, principle 9). */
export interface RunBatch {
  readonly id: string;
  /** Client-supplied; one key covers the whole scope, however many commands. */
  readonly initiationKey: string;
  readonly scope: RunScopeKind;
  /** The command or workstream the scope was taken from; null fleet-wide. */
  readonly scopeId: string | null;
  readonly state: RunBatchState;
  readonly pauseReason: string | null;
  readonly initiatedBy: Author;
  readonly spendCapMicros: number | null;
  readonly createdAt: number;
  readonly settledAt: number | null;
}

export const QUEUED_RUN_STATES = [
  "queued",
  "starting",
  "running",
  /** Its inputs drifted while it waited, so it asks instead of running (§4.1). */
  "needs_reask",
  "done",
  "failed",
  /**
   * A restart caught its session in flight. Its own state, not `done` and not
   * `failed`: nobody stopped it, it did not fail, and it did not finish
   * (principle 11) — the same distinction the session and the run already keep.
   */
  "interrupted",
  "cancelled",
  "paused",
] as const;

export type QueuedRunState = (typeof QUEUED_RUN_STATES)[number];

/**
 * One command's place in the queue.
 *
 * "Queuing is admission of already-initiated work, not scheduling" (§4.1), which
 * is why this record exists at all: the gesture is already in the past, so the
 * thing waiting has to be visible, positioned, and cancellable rather than
 * living in a scheduler's memory.
 *
 * `contractHash` is **the preview as a contract**. It covers the assembled body
 * and the configuration the preview showed; when it no longer matches at
 * admission time the entry re-asks rather than running something else.
 */
export interface QueuedRun {
  readonly id: string;
  readonly batchId: string;
  readonly commandId: CommandId;
  readonly workstreamId: WorkstreamId | null;
  /** 1-based among the entries still waiting; null once it is not waiting. */
  readonly position: number | null;
  readonly state: QueuedRunState;
  readonly contractHash: string;
  readonly spendCapMicros: number | null;
  readonly runId: RunId | null;
  readonly sessionId: SessionId | null;
  /** What it is waiting on, or why it will not run. Never inferred from state. */
  readonly detail: string | null;
  readonly enqueuedAt: number;
  readonly startedAt: number | null;
  readonly settledAt: number | null;
}

/**
 * Whether a queued run may still start. Stated as a predicate so the queue
 * surface, the drain loop, and the cancel verb agree about it (principle 8).
 */
export function isQueuedRunStartable(state: QueuedRunState): boolean {
  return state === "queued";
}

/** Whether cancelling is still meaningful: "cancellable before it starts" (§4.1). */
export function isQueuedRunCancellable(state: QueuedRunState): boolean {
  return state === "queued" || state === "needs_reask" || state === "paused";
}

/**
 * Whether this run is over — whatever it ended as.
 *
 * Stated as a predicate because "not done" and "not finished yet" are different
 * facts and reading one for the other strands work: a command waiting on an
 * upstream that *failed* is waiting for something that is not coming, and a queue
 * that only asked "is it done?" would wait for ever.
 */
export function isQueuedRunSettled(state: QueuedRunState): boolean {
  return (
    state === "done" ||
    state === "failed" ||
    state === "interrupted" ||
    state === "cancelled"
  );
}
