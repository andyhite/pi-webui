/**
 * The plugin manifest and its host-side descriptor (§10.2) — **contract v1, frozen**.
 *
 * A plugin's default export is a {@link PluginManifest}: what it is, what contract
 * version it was built against, what it needs, and what it contributes. Handlers
 * are functions and cannot cross the worker boundary, so the host learns about a
 * plugin through a {@link PluginDescriptor} — the same declaration with the
 * functions removed — and reaches a handler by contribution point plus id.
 *
 * Conformance is checked at the boundary, from the descriptor, because that is the
 * only thing the host ever sees. A manifest that fails conformance makes the
 * **plugin** unavailable with the problems listed; it never makes the product fail
 * to start (§10.2).
 */
import type {
  AgentTool,
  CardRenderer,
  CommandDefinitionContribution,
  ConceptProducer,
  ConditionCheck,
  ContentRenderer,
  NotificationRoute,
  PaletteEntry,
  Panel,
  Theme,
  WorkspaceKind,
  WriteAction,
} from "./contributions.js";
import type { ContributionId, PluginId } from "./ids.js";
import type { PermissionId, PermissionRequest } from "./permissions.js";
import { PERMISSION_KINDS } from "./permissions.js";

/**
 * The contract version this SDK implements.
 *
 * One integer, compared by {@link import("./versioning.js").checkContractVersion}.
 * There is no minor number: a change that a plugin built against v1 survives is not
 * a version change, and one it does not survive is a major.
 */
export const CONTRACT_VERSION = 1;

/**
 * The oldest contract version this host will still load. Equal to
 * {@link CONTRACT_VERSION} today because v1 is the first: nothing older exists to
 * be compatible with.
 */
export const MINIMUM_SUPPORTED_CONTRACT_VERSION = 1;

/** The twelve contribution points of §10.1, as the host names them. */
export const CONTRIBUTION_POINTS = [
  "concept-producer",
  "write-action",
  "agent-tool",
  "content-renderer",
  "card-renderer",
  "panel",
  "palette-entry",
  "workspace-kind",
  "condition-check",
  "notification-route",
  "command-definition",
  "theme",
] as const;

export type ContributionPoint = (typeof CONTRIBUTION_POINTS)[number];

/**
 * What a plugin contributes. Every key optional: a plugin that contributes one
 * thing declares one thing, and a manifest is not a checklist.
 */
export interface PluginContributions {
  readonly conceptProducers?: readonly ConceptProducer[];
  readonly writeActions?: readonly WriteAction[];
  readonly agentTools?: readonly AgentTool[];
  readonly contentRenderers?: readonly ContentRenderer[];
  readonly cardRenderers?: readonly CardRenderer[];
  readonly panels?: readonly Panel[];
  readonly paletteEntries?: readonly PaletteEntry[];
  readonly workspaceKinds?: readonly WorkspaceKind[];
  readonly conditionChecks?: readonly ConditionCheck[];
  readonly notificationRoutes?: readonly NotificationRoute[];
  readonly commandDefinitions?: readonly CommandDefinitionContribution[];
  readonly themes?: readonly Theme[];
}

/** Which manifest key holds which contribution point. */
export const CONTRIBUTION_KEY_BY_POINT: Readonly<
  Record<ContributionPoint, keyof PluginContributions>
> = {
  "concept-producer": "conceptProducers",
  "write-action": "writeActions",
  "agent-tool": "agentTools",
  "content-renderer": "contentRenderers",
  "card-renderer": "cardRenderers",
  panel: "panels",
  "palette-entry": "paletteEntries",
  "workspace-kind": "workspaceKinds",
  "condition-check": "conditionChecks",
  "notification-route": "notificationRoutes",
  "command-definition": "commandDefinitions",
  theme: "themes",
};

/** What a plugin module exports as its default export. */
export interface PluginManifest {
  readonly id: PluginId;
  readonly name: string;
  readonly version: string;
  /** The contract version it was built against; the host refuses or warns (§10.2). */
  readonly contractVersion: number;
  readonly permissions: readonly PermissionRequest[];
  readonly contributions: PluginContributions;
  /** Called before the worker is torn down. A plugin that throws here is ignored. */
  dispose?(): void | Promise<void>;
}

/* --------------------------------------------------------------- descriptors */

/**
 * One contribution as the host sees it: the declaration, with handlers removed.
 *
 * `id` is normalized — an agent tool declares `name` and everything else declares
 * `id`, and the host addresses them all the same way.
 */
export interface ContributionDescriptor {
  readonly point: ContributionPoint;
  readonly id: ContributionId;
  /** Which declared permissions this contribution needs (§10.2). */
  readonly permissions: readonly PermissionId[];
  /** The function-free declaration, exactly as the plugin wrote it. */
  readonly declaration: Readonly<Record<string, unknown>>;
}

export interface PluginDescriptor {
  readonly id: PluginId;
  readonly name: string;
  readonly version: string;
  readonly contractVersion: number;
  readonly permissions: readonly PermissionRequest[];
  readonly contributions: readonly ContributionDescriptor[];
}

export type DescriptorRead =
  | { readonly ok: true; readonly descriptor: PluginDescriptor }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Read the raw, function-free manifest the worker sent into a descriptor.
 *
 * Every failure is a listed problem rather than a throw: an unreadable manifest is
 * an unavailable plugin with a reason a human can act on (§10.2).
 */
export function readDescriptor(raw: unknown): DescriptorRead {
  const problems: string[] = [];
  if (!isRecord(raw)) {
    return { ok: false, problems: ["the default export is not an object"] };
  }
  const id = requireString(raw, "id", problems);
  const name = requireString(raw, "name", problems);
  const version = requireString(raw, "version", problems);
  const contractVersion = raw["contractVersion"];
  if (
    typeof contractVersion !== "number" ||
    !Number.isInteger(contractVersion)
  ) {
    problems.push("contractVersion must be an integer");
  }
  const permissions = readPermissions(raw["permissions"], problems);
  const contributions = readContributions(raw["contributions"], problems);
  if (problems.length > 0) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    descriptor: {
      id,
      name,
      version,
      contractVersion: contractVersion as number,
      permissions,
      contributions,
    },
  };
}

export interface ConformanceResult {
  readonly conformant: boolean;
  /** Every problem, not the first — a plugin author fixes one round, not twelve. */
  readonly problems: readonly string[];
}

/**
 * The semantic rules a conformant manifest satisfies, checked in one place so the
 * host, the tests, and any future packaging tool agree (principle 8).
 *
 * These are the rules the schema already enforces natively, restated where a plugin
 * can break them: a `producing` command definition owes an expected outcome and an
 * `open` one may not carry one (§3.5); a permission request states a reason and a
 * scope of its own kind (§10.2); a contribution asks only for permissions the
 * manifest declared, because a request nobody can see is the silent reach §10.2
 * rules out.
 */
export function checkConformance(
  descriptor: PluginDescriptor,
): ConformanceResult {
  const problems: string[] = [];
  const declared = new Set(descriptor.permissions.map((request) => request.id));

  for (const request of descriptor.permissions) {
    if (request.reason.trim() === "") {
      problems.push(`permission ${request.id} states no reason`);
    }
    if (request.scope.kind !== request.kind) {
      problems.push(
        `permission ${request.id} is a ${request.kind} request with a ${request.scope.kind} scope`,
      );
    }
  }

  const seen = new Set<string>();
  for (const contribution of descriptor.contributions) {
    const key = `${contribution.point}:${contribution.id}`;
    if (seen.has(key)) {
      problems.push(
        `two ${contribution.point} contributions share the id ${contribution.id}`,
      );
    }
    seen.add(key);
    if (contribution.id.trim() === "") {
      problems.push(`a ${contribution.point} contribution has no id`);
    }
    for (const permission of contribution.permissions) {
      if (!declared.has(permission)) {
        problems.push(
          `${contribution.point} ${contribution.id} needs the undeclared permission ${permission}`,
        );
      }
    }
    problems.push(...checkContributionRules(contribution));
  }

  return { conformant: problems.length === 0, problems };
}

function checkContributionRules(
  contribution: ContributionDescriptor,
): readonly string[] {
  const problems: string[] = [];
  const declaration = contribution.declaration;
  switch (contribution.point) {
    case "write-action": {
      const reversibility = declaration["reversibility"];
      if (
        reversibility !== "reversible" &&
        reversibility !== "irreversible" &&
        reversibility !== "unknown"
      ) {
        // An action that forgot to declare would be pre-grantable by omission
        // — exactly the hole §6.6 closes.
        problems.push(
          `write action ${contribution.id} declares no reversibility (§9.2)`,
        );
      }
      break;
    }
    case "command-definition": {
      const lifecycle = declaration["lifecycle"];
      const outcome = declaration["expectedOutcome"];
      if (lifecycle === "producing" && (outcome ?? null) === null) {
        problems.push(
          `command definition ${contribution.id} is producing but names no expected outcome (§3.5)`,
        );
      }
      if (lifecycle === "open" && (outcome ?? null) !== null) {
        problems.push(
          `command definition ${contribution.id} is open but carries an expected outcome (§3.5)`,
        );
      }
      if (lifecycle !== "producing" && lifecycle !== "open") {
        problems.push(
          `command definition ${contribution.id} has no lifecycle (§3.5)`,
        );
      }
      break;
    }
    default:
      break;
  }
  return problems;
}

/* -------------------------------------------------------------------- reading */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function requireString(
  raw: Record<string, unknown>,
  key: string,
  problems: string[],
): string {
  const value = raw[key];
  if (typeof value !== "string" || value.trim() === "") {
    problems.push(`${key} must be a non-empty string`);
    return "";
  }
  return value;
}

function readPermissions(
  raw: unknown,
  problems: string[],
): readonly PermissionRequest[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    problems.push("permissions must be an array");
    return [];
  }
  const requests: PermissionRequest[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry["id"] !== "string") {
      problems.push("a permission request has no id");
      continue;
    }
    const kind = entry["kind"];
    if (
      typeof kind !== "string" ||
      !(PERMISSION_KINDS as readonly string[]).includes(kind)
    ) {
      problems.push(
        `permission ${String(entry["id"])} has an unknown kind ${String(kind)}`,
      );
      continue;
    }
    if (!isRecord(entry["scope"])) {
      problems.push(`permission ${String(entry["id"])} has no scope`);
      continue;
    }
    requests.push(entry as unknown as PermissionRequest);
  }
  return requests;
}

function readContributions(
  raw: unknown,
  problems: string[],
): readonly ContributionDescriptor[] {
  if (raw === undefined) {
    return [];
  }
  if (!isRecord(raw)) {
    problems.push("contributions must be an object");
    return [];
  }
  const descriptors: ContributionDescriptor[] = [];
  for (const point of CONTRIBUTION_POINTS) {
    const entries = raw[CONTRIBUTION_KEY_BY_POINT[point]];
    if (entries === undefined) {
      continue;
    }
    if (!Array.isArray(entries)) {
      problems.push(`${CONTRIBUTION_KEY_BY_POINT[point]} must be an array`);
      continue;
    }
    for (const entry of entries) {
      if (!isRecord(entry)) {
        problems.push(`a ${point} contribution is not an object`);
        continue;
      }
      // An agent tool is addressed by `name`; everything else by `id`.
      const id = entry["id"] ?? entry["name"];
      if (typeof id !== "string") {
        problems.push(`a ${point} contribution has no id`);
        continue;
      }
      descriptors.push({
        point,
        id,
        permissions: readPermissionIds(entry),
        declaration: entry,
      });
    }
  }
  return descriptors;
}

function readPermissionIds(
  entry: Record<string, unknown>,
): readonly PermissionId[] {
  const direct = entry["permissions"];
  if (Array.isArray(direct)) {
    return direct.filter((value): value is string => typeof value === "string");
  }
  // Agent tools nest theirs under `requires`, matching core's `ToolRequirements`.
  const requires = entry["requires"];
  if (isRecord(requires) && Array.isArray(requires["permissions"])) {
    return requires["permissions"].filter(
      (value): value is string => typeof value === "string",
    );
  }
  return [];
}
