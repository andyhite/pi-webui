import { access } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type {
  CommandExec,
  ConditionEvaluation,
  Workspace,
  WorldCondition,
} from "@plotroom/core";

/**
 * The world-condition check registry (§3.5, principle 3).
 *
 * "Completion is proof, not a claim." A world condition is a *declaration* —
 * `pull_request_exists`, `checks_green` — and the thing that can observe it
 * lives with the integration that knows how. This registry is the seam between
 * the two, so a plugin (§10.1) supplies checks later without the run path
 * learning a second way to ask.
 *
 * The important rule is what happens when nothing can check a declared
 * condition: the evaluation says it does not hold, and says why. "Nobody
 * checked" is not proof, and `checkSubmission` in `@plotroom/core` already
 * treats an unevaluated condition as a failure — this registry never quietly
 * supplies a passing one to make a submission go through.
 */
export interface ConditionCheckRequest {
  readonly condition: WorldCondition;
  readonly workspace: Workspace;
  /** The workspace root the condition is evaluated against. */
  readonly workspacePath: string;
}

export interface ConditionChecker {
  /** The declared predicate this checker answers, e.g. "workspace_file_exists". */
  readonly predicate: string;
  /** What it needs, quoted back when a declaration is missing an argument. */
  readonly requires: readonly string[];
  check(request: ConditionCheckRequest): Promise<ConditionEvaluation>;
}

export class ConditionCheckRegistry {
  readonly #checkers = new Map<string, ConditionChecker>();

  register(checker: ConditionChecker): void {
    this.#checkers.set(checker.predicate, checker);
  }

  predicates(): readonly string[] {
    return [...this.#checkers.keys()];
  }

  /**
   * Evaluate every declared condition. Order is preserved and nothing is
   * skipped: the run path hands the whole list to `checkSubmission`, which is
   * where "every condition was evaluated *and* holds" is decided.
   */
  async evaluate(
    conditions: readonly WorldCondition[],
    context: { readonly workspace: Workspace; readonly workspacePath: string },
  ): Promise<ConditionEvaluation[]> {
    const evaluations: ConditionEvaluation[] = [];

    for (const condition of conditions) {
      const checker = this.#checkers.get(condition.predicate);

      if (checker === undefined) {
        evaluations.push({
          conditionId: condition.id,
          holds: false,
          detail: `no checker is available for predicate "${condition.predicate}"; nobody checked, which is not proof`,
        });
        continue;
      }

      try {
        evaluations.push(
          await checker.check({
            condition,
            workspace: context.workspace,
            workspacePath: context.workspacePath,
          }),
        );
      } catch (error) {
        // A checker that throws has not proven anything either.
        evaluations.push({
          conditionId: condition.id,
          holds: false,
          detail: `checking "${condition.predicate}" failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }

    return evaluations;
  }
}

/**
 * The checks that ship in the box. They are deliberately about the workspace:
 * that is the only outside world this phase can observe, and a check that
 * needs GitHub belongs to the GitHub plugin (§9.4, §10.1).
 */
export function createConditionChecks(
  exec: CommandExec,
): ConditionCheckRegistry {
  const registry = new ConditionCheckRegistry();
  registry.register(workspaceFileExists());
  registry.register(workspaceCommandSucceeds(exec));
  return registry;
}

/** `workspace_file_exists` — args: `path`, relative to the workspace root. */
export function workspaceFileExists(): ConditionChecker {
  return {
    predicate: "workspace_file_exists",
    requires: ["path"],
    async check({ condition, workspacePath }) {
      const path = condition.args?.["path"];
      if (path === undefined || path === "") {
        return missingArgument(condition, "path");
      }

      const target = insideWorkspace(workspacePath, path);
      if (target === null) {
        return {
          conditionId: condition.id,
          holds: false,
          detail: `"${path}" is outside the workspace; a condition is checked inside it`,
        };
      }

      try {
        await access(target);
        return { conditionId: condition.id, holds: true };
      } catch {
        return {
          conditionId: condition.id,
          holds: false,
          detail: `${path} does not exist in the workspace`,
        };
      }
    },
  };
}

/**
 * `workspace_command_succeeds` — args: `program`, optional `args` (space
 * separated) and `subdirectory`. Exit code zero holds; anything else comes back
 * as feedback with the command's own output, whole (principle 12).
 */
export function workspaceCommandSucceeds(exec: CommandExec): ConditionChecker {
  return {
    predicate: "workspace_command_succeeds",
    requires: ["program"],
    async check({ condition, workspacePath }) {
      const program = condition.args?.["program"];
      if (program === undefined || program === "") {
        return missingArgument(condition, "program");
      }

      const subdirectory = condition.args?.["subdirectory"] ?? "";
      const cwd =
        subdirectory === ""
          ? workspacePath
          : insideWorkspace(workspacePath, subdirectory);
      if (cwd === null) {
        return {
          conditionId: condition.id,
          holds: false,
          detail: `"${subdirectory}" is outside the workspace`,
        };
      }

      const args = (condition.args?.["args"] ?? "")
        .split(" ")
        .filter((part) => part.length > 0);

      const result = await exec({
        program,
        args,
        cwd,
        // The host's environment, not the app's: a workspace command is exactly
        // where an app credential must not appear (§3.4, §9.3).
        env: hostEnvironment(),
      });

      if (result.exitCode === 0) {
        return { conditionId: condition.id, holds: true };
      }

      return {
        conditionId: condition.id,
        holds: false,
        detail: `${program} exited ${result.exitCode}: ${
          result.stderr.trim() || result.stdout.trim() || "no output"
        }`,
      };
    },
  };
}

function missingArgument(
  condition: WorldCondition,
  name: string,
): ConditionEvaluation {
  return {
    conditionId: condition.id,
    holds: false,
    detail: `"${condition.predicate}" needs a ${name} argument; this condition declares none`,
  };
}

/** Path containment, so a declared condition cannot read outside the boundary. */
function insideWorkspace(root: string, relative: string): string | null {
  if (isAbsolute(relative)) return null;
  const absoluteRoot = resolve(root);
  const target = resolve(join(absoluteRoot, relative));
  if (target !== absoluteRoot && !target.startsWith(`${absoluteRoot}/`)) {
    return null;
  }
  return target;
}

function hostEnvironment(): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}
