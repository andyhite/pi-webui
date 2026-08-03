import type { ConditionEvaluation } from "@plotroom/core";
import type {
  ContributionDescriptor,
  PluginDescriptor,
} from "@plotroom/plugin-sdk";
import type {
  ConditionCheckRequest,
  ConditionChecker,
} from "../conditions/registry.js";
import type { PluginInvoker } from "./invoker.js";

/**
 * A plugin's condition checks, mounted in the server's own condition registry
 * (§3.5, §4.3, principle 3 — Epic 7.3's ask of this track).
 *
 * The registry's docstring already said what this is: "a world condition is a
 * declaration ... and the thing that can observe it lives with the integration that
 * knows how. This registry is the seam between the two, so a plugin supplies checks
 * later **without the run path learning a second way to ask**." This is that later.
 *
 * Two details carry the weight:
 *
 * - **The workspace path is supplied into the declared input.** A `ConditionCheck`
 *   receives an input and a call context and nothing else — the contract hands it no
 *   workspace — so the git plugin's checks declare a `path` field and say in the
 *   port's own words that "the server's condition registry knows the workspace and
 *   is the one that can fill it in". This fills it in: any declared string field
 *   named in {@link WORKSPACE_PATH_FIELDS} that the condition itself did not supply
 *   gets the workspace root. A check that declares none (GitHub's two) is unaffected
 *   — nothing is injected where nothing was declared.
 * - **`unknown` is not proof.** The contract's third state maps to `holds: false`
 *   with the plugin's own evidence, exactly as the registry already treats a check
 *   nobody could run: "nobody checked, which is not proof". `met` is the only state
 *   that holds.
 */
export const WORKSPACE_PATH_FIELDS = ["path", "workspacePath"] as const;

export function hostedConditionCheckers(input: {
  readonly descriptor: PluginDescriptor;
  readonly invoker: PluginInvoker;
}): readonly ConditionChecker[] {
  const checkers: ConditionChecker[] = [];
  for (const contribution of input.descriptor.contributions) {
    if (contribution.point !== "condition-check") continue;
    const schema = readInputSchema(contribution);
    checkers.push({
      predicate: contribution.id,
      requires: schema.required,
      check: async (
        request: ConditionCheckRequest,
      ): Promise<ConditionEvaluation> => {
        const result = await input.invoker.invoke(input.descriptor.id, {
          kind: "condition.check",
          contributionId: contribution.id,
          input: checkInput(request, schema.fields),
        });
        return {
          conditionId: request.condition.id,
          holds: result.state === "met",
          ...(result.state === "met" && result.evidence === ""
            ? {}
            : {
                detail:
                  result.state === "unknown"
                    ? `${input.descriptor.id} could not tell: ${result.evidence} — which is not proof`
                    : result.evidence,
              }),
        };
      },
    });
  }
  return checkers;
}

/**
 * The input one check gets: the condition's own declared arguments, plus the
 * workspace root wherever the check declared a field for it and the condition
 * supplied none. Never anything else — a check is handed what was declared, not the
 * server's whole world.
 */
function checkInput(
  request: ConditionCheckRequest,
  fields: readonly string[],
): Record<string, unknown> {
  const supplied: Record<string, unknown> = {
    ...(request.condition.args ?? {}),
  };
  for (const field of WORKSPACE_PATH_FIELDS) {
    if (!fields.includes(field)) continue;
    const value = supplied[field];
    if (value === undefined || value === "") {
      supplied[field] = request.workspacePath;
    }
  }
  return supplied;
}

function readInputSchema(contribution: ContributionDescriptor): {
  readonly fields: readonly string[];
  readonly required: readonly string[];
} {
  const declared = contribution.declaration["input"];
  if (typeof declared !== "object" || declared === null) {
    return { fields: [], required: [] };
  }
  const fields: string[] = [];
  const required: string[] = [];
  for (const [name, field] of Object.entries(
    declared as Record<string, unknown>,
  )) {
    fields.push(name);
    if (
      typeof field === "object" &&
      field !== null &&
      (field as { required?: unknown }).required === true
    ) {
      required.push(name);
    }
  }
  return { fields, required };
}
