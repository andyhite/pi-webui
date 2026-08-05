import type { Renderings } from "../renderings.js";
import type {
  RuntimeObservation,
  TodoPhaseSnapshot,
  TodoTaskSnapshot,
} from "./runtime.js";

/**
 * The runtime's plan, projected as content (§3.6, §3.1).
 *
 * A plan is not a tenth concept: §3.1's Document is already "a durable piece
 * of prose: a spec, a plan, a design note, a file's contents"
 * (`docs/product-spec.md:62`), so this renders `TodoPhaseSnapshot[]` — folded
 * from the observation log exactly once, in `SessionObservationState.phases`
 * — the same way `transcript.ts` renders `Transcript`. Nothing here decides
 * whether or when a version is written; that is the checkpoint rule
 * (`checkpoint.ts`), unchanged.
 */

function renderTaskLine(task: TodoTaskSnapshot): string {
  const box = task.status === "completed" ? "[x]" : "[ ]";
  const suffix =
    task.status === "in_progress"
      ? " *(in progress)*"
      : task.status === "abandoned"
        ? " *(abandoned)*"
        : task.status === "blocked"
          ? ` *(blocked: ${task.blocker ?? "unspecified"})*`
          : "";
  return `- ${box} ${task.content}${suffix}`;
}

/**
 * A GFM task list, one heading per phase — the plain, obviously-reversible
 * shape every markdown reader and writer already agrees on. (The product
 * spec references a round-tripped markdown form for this; that reference was
 * not available while writing this renderer, so this is a fresh, documented
 * choice rather than a match against it.)
 */
export function renderPlanMarkdown(
  phases: readonly TodoPhaseSnapshot[],
): string {
  if (phases.length === 0) return "_No plan yet._";
  return phases
    .map((phase) => {
      const tasks =
        phase.tasks.length === 0
          ? "_No tasks._"
          : phase.tasks.map(renderTaskLine).join("\n");
      return `## ${phase.name}\n\n${tasks}`;
    })
    .join("\n\n");
}

function countTasks(phases: readonly TodoPhaseSnapshot[]): {
  readonly total: number;
  readonly completed: number;
} {
  let total = 0;
  let completed = 0;
  for (const phase of phases) {
    for (const task of phase.tasks) {
      total += 1;
      if (task.status === "completed") completed += 1;
    }
  }
  return { total, completed };
}

/** §3.2: every object renders three ways, the plan included. */
export function planRenderings(
  phases: readonly TodoPhaseSnapshot[],
): Renderings {
  const { total, completed } = countTasks(phases);
  return {
    card: { phases: phases.length, tasks: total, completed },
    summary:
      total === 0 ? "plan · no tasks yet" : `plan · ${completed}/${total} done`,
    agentContent: renderPlanMarkdown(phases),
  };
}

/**
 * No delta today: unlike the transcript's new-turns-only view, "what changed
 * in a plan" needs a structural diff this project has not specified, and
 * `chooseDelta`'s own fallback (§3.2) — full content when a delta would not
 * be smaller — is the honest answer until one exists. `publishTranscript`'s
 * plan write already omits a delta for the same reason `session-transcript`
 * does not export one either.
 */

/**
 * One task a session has told the runtime it cannot advance right now (§7.2,
 * #155). `since` is the observed moment the block began, never "now" —
 * principle 7 forbids inferring a duration nobody reported. Blocked tasks are
 * unaffected by resume's completed/abandoned stripping (#150), so unlike
 * {@link TodoPhaseSnapshot}'s own reconciliation this reads each
 * `plan-updated` observation's raw snapshot directly rather than the folded,
 * resume-safe one — a block's history is exactly what a snapshot-only fold
 * cannot answer.
 */
export interface BlockedTask {
  readonly phaseName: string;
  readonly content: string;
  readonly blocker: string;
  readonly since: number;
}

/**
 * Every task presently blocked, each with the timestamp its current
 * unbroken blocked streak began. Matched by phase name plus task content —
 * the only identity either side has — so a task blocked, unblocked, and
 * blocked again gets a fresh `since` rather than the first one.
 */
export function blockedTasksSince(
  observations: readonly RuntimeObservation[],
): readonly BlockedTask[] {
  const since = new Map<string, { blocker: string; since: number }>();

  for (const observation of observations) {
    if (observation.kind !== "plan-updated") continue;
    const stillBlocked = new Set<string>();

    for (const phase of observation.phases) {
      for (const task of phase.tasks) {
        if (task.status !== "blocked") continue;
        const key = `${phase.name}\u0000${task.content}`;
        stillBlocked.add(key);
        // since is pinned to the streak's first sighting; blocker always
        // tracks the latest — a re-block with a new reason is a legal,
        // observed update (omp's block moves an already-blocked target too),
        // and the alert's summary must serve the current line, not the
        // superseded one.
        since.set(key, {
          blocker: task.blocker ?? "unspecified",
          since: since.get(key)?.since ?? observation.at,
        });
      }
    }

    for (const key of since.keys()) {
      if (!stillBlocked.has(key)) since.delete(key);
    }
  }

  return [...since.entries()].map(([key, value]) => {
    const separator = key.indexOf("\u0000");
    return {
      phaseName: key.slice(0, separator),
      content: key.slice(separator + 1),
      blocker: value.blocker,
      since: value.since,
    };
  });
}
