import type { Renderings } from "../renderings.js";
import type { TodoPhaseSnapshot, TodoTaskSnapshot } from "./runtime.js";

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
