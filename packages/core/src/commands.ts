import type {
  CommandDefinitionId,
  CommandId,
  ObjectId,
  OutputId,
  RunId,
  WorkstreamId,
} from "./ids.js";
import type { ObjectKind, ObjectScope } from "./objects.js";

/**
 * Spec §3.5: a command is a named, reusable set of marching orders — the
 * instruction, the model and effort, the tool permissions, what it expects to
 * produce, and where the user wants to be asked.
 *
 * The spec draws one line this module keeps sharp: a **definition** is
 * reusable, editable content; a **command node** is one instance on the graph,
 * a definition plus its wiring.
 */

/** Effort is a launch choice alongside the model (§3.5, §3.6). */
export const EFFORT_LEVELS = ["low", "medium", "high"] as const;

export type Effort = (typeof EFFORT_LEVELS)[number];

export interface ModelChoice {
  readonly model: string;
  readonly effort: Effort;
}

/**
 * Tool permissions are declared, not inferred. An empty `allowed` list is a
 * command that may use no tools — the honest reading of "no permissions",
 * never "all of them".
 */
export interface ToolPermissions {
  readonly allowed: readonly string[];
  readonly denied: readonly string[];
}

/**
 * "Where the user wants to be asked" (§3.5), answered against §6.6's list of
 * what raises an approval: a command to dispatch, a write to an external
 * system, a claim outside standing policy, destroying authored state.
 */
export const ASK_POINTS = [
  "external_write",
  "irreversible_write",
  "destructive_state",
  "claim_outside_policy",
  "command_dispatch",
] as const;

export type AskPoint = (typeof ASK_POINTS)[number];

/**
 * Spec §6.6: "irreversibility pierces pre-grants" — an irreversible write
 * always raises an approval regardless of what was pre-granted. A definition
 * therefore cannot opt out of it, which is why the effective set is computed
 * rather than read straight off the definition.
 */
export const ALWAYS_ASK: readonly AskPoint[] = ["irreversible_write"];

export function effectiveAskPoints(
  declared: readonly AskPoint[],
): readonly AskPoint[] {
  const effective = new Set<AskPoint>(declared);
  for (const point of ALWAYS_ASK) effective.add(point);
  return ASK_POINTS.filter((point) => effective.has(point));
}

/**
 * Parameters (§3.5): a definition may declare inputs it asks for when used,
 * so a reusable recipe does not hardcode values wrong in every other
 * repository.
 */
export const PARAMETER_TYPES = [
  "text",
  "number",
  "boolean",
  "enum",
  "object_ref",
] as const;

export type ParameterType = (typeof PARAMETER_TYPES)[number];

export type ParameterValue = string | number | boolean;

export interface CommandParameter {
  readonly name: string;
  readonly label: string;
  readonly type: ParameterType;
  readonly required: boolean;
  /** Enum parameters only: the values the user may pick from. */
  readonly options?: readonly string[];
}

/**
 * Spec §3.5: "Defaults may be suggested where honestly derivable from the
 * target — a proposal the user confirms, never a guess applied silently."
 *
 * The two states are separate variants rather than a `confirmed` flag on one
 * shape, so nothing can read a value out of a proposal by accident: a
 * `proposed` binding carries no confirmed value at all, and the resolver below
 * refuses to produce run configuration while one is outstanding.
 */
export type ParameterBinding =
  | {
      readonly name: string;
      readonly state: "proposed";
      readonly proposal: ParameterValue;
      /** Where the proposal came from, so the user can judge it (§3.5). */
      readonly derivedFrom: string;
    }
  | {
      readonly name: string;
      readonly state: "confirmed";
      readonly value: ParameterValue;
      readonly confirmedAt: number;
    };

/**
 * Confirming a proposal. The user may confirm the proposed value or replace
 * it; either way the result is a confirmed binding, and there is no path from
 * `proposed` to a value that does not pass through here.
 */
export function confirmParameter(
  binding: ParameterBinding,
  now: number,
  replacement?: ParameterValue,
): ParameterBinding {
  const value =
    replacement ??
    (binding.state === "proposed" ? binding.proposal : binding.value);

  return { name: binding.name, state: "confirmed", value, confirmedAt: now };
}

export type ParameterResolution =
  | {
      readonly ready: true;
      readonly values: Readonly<Record<string, ParameterValue>>;
    }
  | {
      readonly ready: false;
      /** Derived defaults still awaiting confirmation (§3.5). */
      readonly unconfirmed: readonly string[];
      /** Required parameters with no binding at all. */
      readonly missing: readonly string[];
    };

/**
 * The one place a command's parameter values come from. A proposed default is
 * reported as unconfirmed and contributes no value — that is the "never
 * silently applied" rule, enforced rather than documented.
 */
export function resolveParameters(
  parameters: readonly CommandParameter[],
  bindings: readonly ParameterBinding[],
): ParameterResolution {
  const byName = new Map(bindings.map((binding) => [binding.name, binding]));
  const values: Record<string, ParameterValue> = {};
  const unconfirmed: string[] = [];
  const missing: string[] = [];

  for (const parameter of parameters) {
    const binding = byName.get(parameter.name);

    if (!binding) {
      if (parameter.required) missing.push(parameter.name);
      continue;
    }

    if (binding.state === "proposed") {
      unconfirmed.push(parameter.name);
      continue;
    }

    values[parameter.name] = binding.value;
  }

  if (unconfirmed.length > 0 || missing.length > 0) {
    return { ready: false, unconfirmed, missing };
  }

  return { ready: true, values };
}

/**
 * World conditions (§3.5): predicates checked against the outside world,
 * declared by the definition. They are declarations, not code — the checker
 * that evaluates one lives with the integration that can observe it.
 */
export interface WorldCondition {
  readonly id: string;
  /** The declared predicate, e.g. "pull_request_exists", "checks_green". */
  readonly predicate: string;
  /** Shown as feedback when it fails, so the agent knows what to fix. */
  readonly description: string;
  readonly args?: Readonly<Record<string, string>>;
}

/**
 * The expected outcome of a producing command (§3.5): a named, typed object,
 * optionally with structure, optionally with world conditions. The name is the
 * output's name in `command/name@n` addressing (§15 invariant 4).
 */
export interface ExpectedOutcome {
  readonly name: string;
  readonly kind: ObjectKind;
  /** Optional structure the produced object must carry. */
  readonly structure?: Readonly<Record<string, unknown>>;
  readonly conditions: readonly WorldCondition[];
}

/** Spec §3.5: producing declares an outcome, open ends when the user ends it. */
export const COMMAND_LIFECYCLES = ["producing", "open"] as const;

export type CommandLifecycle = (typeof COMMAND_LIFECYCLES)[number];

/**
 * Content budget (§3.5): assembly warns as content approaches the model's
 * window, and a hard cap is opt-in. There is deliberately no "truncate to"
 * result — the product never silently truncates (principle 12), so the only
 * answers are proceed, warn, or refuse.
 */
export interface ContentBudget {
  readonly modelWindowTokens: number;
  /** Fraction of the window at which assembly warns. */
  readonly warnAtFraction: number;
  /** Opt-in per command; null means no hard cap (§3.5). */
  readonly hardCapTokens: number | null;
}

export const DEFAULT_CONTENT_BUDGET: ContentBudget = {
  modelWindowTokens: 200_000,
  warnAtFraction: 0.85,
  hardCapTokens: null,
};

export type BudgetCheck =
  | { readonly state: "ok"; readonly estimatedTokens: number }
  | {
      readonly state: "warn";
      readonly estimatedTokens: number;
      readonly message: string;
    }
  | {
      readonly state: "refused";
      readonly estimatedTokens: number;
      readonly message: string;
    };

/**
 * A deliberately crude estimate, stated once so assembly, the run preview, and
 * the canvas all warn at the same number. Precision is not the point: the
 * product's answer to "too big" is to refuse or warn, never to guess a
 * truncation point (principle 12). Counted in characters rather than bytes so
 * this package stays free of platform imports.
 */
export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

export function checkContentBudget(
  estimatedTokens: number,
  budget: ContentBudget,
): BudgetCheck {
  if (budget.hardCapTokens !== null && estimatedTokens > budget.hardCapTokens) {
    return {
      state: "refused",
      estimatedTokens,
      message: `assembled content is ${estimatedTokens} tokens, over this command's hard cap of ${budget.hardCapTokens}; remove inputs rather than truncating`,
    };
  }

  if (estimatedTokens >= budget.modelWindowTokens * budget.warnAtFraction) {
    return {
      state: "warn",
      estimatedTokens,
      message: `assembled content is ${estimatedTokens} tokens, close to the model's ${budget.modelWindowTokens}-token window`,
    };
  }

  return { state: "ok", estimatedTokens };
}

/**
 * A command definition (§3.5): reusable, editable content, not code. Created,
 * duplicated, and organized by the user; shipped first-party in the box, and
 * shippable inside plugins — which is what `source` records.
 */
export const DEFINITION_SOURCES = ["builtin", "user", "plugin"] as const;

export type DefinitionSource = (typeof DEFINITION_SOURCES)[number];

export interface CommandDefinition {
  readonly id: CommandDefinitionId;
  readonly name: string;
  /** The marching orders themselves: user-editable content (§3.5). */
  readonly instruction: string;
  readonly model: ModelChoice;
  readonly permissions: ToolPermissions;
  readonly askPoints: readonly AskPoint[];
  readonly lifecycle: CommandLifecycle;
  /** Producing definitions declare one; open definitions never do (§3.5). */
  readonly outcome: ExpectedOutcome | null;
  readonly parameters: readonly CommandParameter[];
  readonly budget: ContentBudget;
  readonly source: DefinitionSource;
  /** Organization is authored: a user-named folder, or the top level. */
  readonly folder: string | null;
  /** Set when this definition was duplicated from another (§3.5). */
  readonly duplicatedFrom: CommandDefinitionId | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A command node: a definition plus its wiring, inside one workstream (§3.5). */
export interface CommandNode {
  readonly id: CommandId;
  readonly definitionId: CommandDefinitionId;
  /** A command never leaves its workstream (§3.3). */
  readonly workstreamId: WorkstreamId;
  readonly createdAt: number;
  readonly deletedAt: number | null;
}

/**
 * Output pre-wiring (§3.5): a producing command's output exists *before any
 * run* as a typed placeholder and can be wired as context into other commands.
 * After a run it binds to what was produced.
 */
export interface CommandOutput {
  readonly id: OutputId;
  readonly commandId: CommandId;
  readonly name: string;
  readonly kind: ObjectKind;
  /**
   * The publish verb (§3.5): marks a *placeholder* world-visible before a run,
   * so commands in other workstreams may wire to it. Distinct from promote,
   * which lifts an existing object after the fact (§3.2).
   */
  readonly publishedAt: number | null;
  readonly boundObjectId: ObjectId | null;
  readonly boundRunId: RunId | null;
  readonly boundAt: number | null;
  /**
   * Set when the producing command was deleted while this output was still a
   * placeholder: the downstream wire stays and is visibly broken, never a
   * silent unblock (§3.5).
   */
  readonly brokenAt: number | null;
}

/** The two states of §3.5's cross-workstream rule, as one predicate. */
export type OutputBindState = "pre_bind" | "post_bind";

export function outputBindState(output: CommandOutput): OutputBindState {
  return output.boundObjectId === null ? "pre_bind" : "post_bind";
}

/**
 * What deleting the producing command does to a downstream wire (§3.5).
 *
 * Pre-bind, the wire is a promise, and deleting the producer leaves a visibly
 * broken placeholder — the downstream command is still blocked, and it says
 * so. Post-bind, what crosses is the produced object, so the command
 * dependency has already evaporated and the object survives untouched.
 */
export type ProducerDeletionEffect =
  | { readonly effect: "broken_placeholder"; readonly message: string }
  | { readonly effect: "object_intact"; readonly objectId: ObjectId };

export function effectOfDeletingProducer(
  output: CommandOutput,
): ProducerDeletionEffect {
  if (output.boundObjectId !== null) {
    return { effect: "object_intact", objectId: output.boundObjectId };
  }

  return {
    effect: "broken_placeholder",
    message: `"${output.name}" was never produced; its command is gone and everything waiting on it is still blocked`,
  };
}

/**
 * Publish is refused on an output that has already bound (§3.5): publish marks
 * a placeholder *before* a run, and after the bind the thing to lift into
 * world scope is the produced object, via promote. Two verbs, kept two.
 */
export type PublishRefusal = {
  readonly reason: "already_bound";
  readonly message: string;
};

export type PublishCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly refusal: PublishRefusal };

export function checkPublish(output: CommandOutput): PublishCheck {
  if (output.boundObjectId === null) return { allowed: true };

  return {
    allowed: false,
    refusal: {
      reason: "already_bound",
      message:
        "this output already produced an object; promote the object instead of publishing the placeholder",
    },
  };
}

/**
 * Spec §3.5: publishing is what lets commands in *other* workstreams wire to a
 * placeholder — the product's only cross-workstream dependency. An
 * unpublished placeholder stays inside its workstream, and a broken one is
 * not silently wireable either.
 */
export type OutputCrossingRefusal =
  | { readonly reason: "unpublished_output"; readonly message: string }
  | { readonly reason: "local_bound_output"; readonly message: string }
  | { readonly reason: "broken_output"; readonly message: string };

export type OutputCrossingCheck =
  | { readonly legal: true }
  | { readonly legal: false; readonly refusal: OutputCrossingRefusal };

export interface OutputCrossingFacts {
  readonly workstreamId: WorkstreamId;
  readonly published: boolean;
  readonly broken: boolean;
  /**
   * The produced object's scope once the output has bound; null while it is
   * still a placeholder. Bound-ness is carried *as* the scope rather than
   * beside it as a flag, because post-bind the only question worth asking is
   * the object's — and two fields that must agree is a rule waiting to break.
   */
  readonly boundScope: ObjectScope | null;
}

export function checkOutputCrossing(
  output: OutputCrossingFacts,
  targetWorkstreamId: WorkstreamId | null,
): OutputCrossingCheck {
  if (output.broken) {
    return {
      legal: false,
      refusal: {
        reason: "broken_output",
        message:
          "that placeholder's command was deleted before it produced anything",
      },
    };
  }

  const crosses = targetWorkstreamId !== output.workstreamId;
  if (!crosses) return { legal: true };

  // Post-bind the command dependency has evaporated and what crosses is the
  // produced object (§3.5), so the object's own scope decides — exactly as it
  // would if that object were wired from its own content node (§3.3).
  // Publishing before the run is what promotes it; an output that bound
  // without being published produced a local object, and a local object does
  // not cross just because a placeholder is standing in front of it.
  if (output.boundScope !== null) {
    return output.boundScope === "world"
      ? { legal: true }
      : {
          legal: false,
          refusal: {
            reason: "local_bound_output",
            message:
              "that output produced a local object; promote it to world scope first",
          },
        };
  }

  if (output.published) return { legal: true };

  return {
    legal: false,
    refusal: {
      reason: "unpublished_output",
      message:
        "publish this output first; an unpublished placeholder stays in its own workstream",
    },
  };
}

/**
 * Completion is proof, not a claim (§3.5). A submission is accepted only when
 * every declared condition was evaluated *and* holds; an unevaluated condition
 * is a failure, because "nobody checked" is not proof.
 */
export interface ConditionEvaluation {
  readonly conditionId: string;
  readonly holds: boolean;
  /** Returned to the agent as feedback when it fails (§3.5). */
  readonly detail?: string;
}

/**
 * Proof is point-in-time: what held at submission, recorded once. Nothing
 * re-evaluates it into revocation — a condition that regresses later surfaces
 * as drift on done work (§4.5), and a human decides (principle 2).
 */
export interface CompletionProof {
  readonly provenAt: number;
  readonly conditions: readonly ConditionEvaluation[];
}

export type SubmissionOutcome =
  | { readonly accepted: true; readonly proof: CompletionProof }
  | {
      readonly accepted: false;
      readonly failed: readonly ConditionEvaluation[];
      /** Handed back to the session, which continues within its budget (§3.5). */
      readonly feedback: string;
    };

export function checkSubmission(
  outcome: ExpectedOutcome,
  evaluations: readonly ConditionEvaluation[],
  now: number,
): SubmissionOutcome {
  const byId = new Map(
    evaluations.map((evaluation) => [evaluation.conditionId, evaluation]),
  );

  const resolved = outcome.conditions.map(
    (condition): ConditionEvaluation =>
      byId.get(condition.id) ?? {
        conditionId: condition.id,
        holds: false,
        detail: `"${condition.description}" was never checked`,
      },
  );

  const failed = resolved.filter((evaluation) => !evaluation.holds);

  if (failed.length > 0) {
    return {
      accepted: false,
      failed,
      feedback: failed
        .map(
          (evaluation) =>
            `${evaluation.conditionId}: ${evaluation.detail ?? "does not hold"}`,
        )
        .join("; "),
    };
  }

  return { accepted: true, proof: { provenAt: now, conditions: resolved } };
}
