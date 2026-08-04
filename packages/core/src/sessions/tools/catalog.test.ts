import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AGENT_TOOL_CATALOG,
  destructionTools,
  liveTools,
  pathParametersOf,
  sessionCallableTools,
  toolByName,
  TOOL_INPUT_TYPES,
  type AgentTool,
  type HttpMethod,
} from "./catalog.js";

/**
 * One vocabulary, enforced (principle 8, and the plan's cross-cutting rule 2: "no
 * UI capability without the matching API/agent tool, and vice versa").
 *
 * This reads the server's own route registrations and compares them with the
 * catalog in both directions. Reading `apps/server` from a `packages/core` test is
 * deliberate: the routes are the vocabulary, and a check that only compared the
 * catalog with itself would pass while the two drifted apart. It is a read; core
 * does not depend on the server.
 */

const ROUTES_DIR = fileURLToPath(
  new URL("../../../../../apps/server/src/routes", import.meta.url),
);

const API_PREFIX = "/api";

/**
 * Every verb the scanner recognises — deliberately **wider** than `HttpMethod`,
 * which is the set the catalog can express.
 *
 * A scanner that only looked for the verbs the catalog knows about could never
 * report the one drift that matters most: a route mounted under a verb no tool can
 * name. `PUT /api/settings/:key` was exactly that — unscanned, so neither
 * direction below could see it, and a body-write endpoint shipped with the
 * vocabulary check passing over it rather than judging it. Scanning the wider set
 * is the fix: the route is found, and then it either has a tool or is declared
 * operator-only like every other endpoint.
 */
type ScannedMethod = HttpMethod | "PUT";

interface MountedRoute {
  readonly method: ScannedMethod;
  /** With `/api` prepended, and every `${...}` expanded to the literal it loops over. */
  readonly path: string;
  readonly source: string;
}

const ROUTE_CALL =
  /app\.(get|post|put|patch|delete)\(\s*(?:"([^"]+)"|`([^`]+)`)/g;

/** `for (const gesture of ["archive", "unarchive"] as const)` — one route per value. */
const LOOP_LITERAL = /for \(const (\w+) of \[([^\]]+)\]/g;

function loopValues(source: string): ReadonlyMap<string, readonly string[]> {
  const values = new Map<string, readonly string[]>();
  for (const match of source.matchAll(LOOP_LITERAL)) {
    const name = match[1] as string;
    const literals = [...(match[2] as string).matchAll(/"([^"]+)"/g)].map(
      (entry) => entry[1] as string,
    );
    if (literals.length > 0) values.set(name, literals);
  }
  return values;
}

/**
 * Expanded rather than wildcarded on purpose: a `/workstreams/:id/*` pattern would
 * happily "match" every future sub-route, and this suite would report a
 * vocabulary as covered because a loop over two gestures blurred into it.
 */
function expand(
  path: string,
  values: ReadonlyMap<string, readonly string[]>,
): string[] {
  const interpolation = /\$\{\s*(\w+)\s*\}/.exec(path);
  if (interpolation === null) return [path];

  const candidates = values.get(interpolation[1] as string);
  if (candidates === undefined) {
    throw new Error(
      `cannot expand ${path}: no string-literal loop found for \${${interpolation[1]}}. ` +
        "Teach this parser the new shape rather than loosening the match.",
    );
  }
  return candidates.flatMap((value) =>
    expand(path.replace(interpolation[0], value), values),
  );
}

function mountedRoutes(): readonly MountedRoute[] {
  const files = readdirSync(ROUTES_DIR).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  );
  const routes: MountedRoute[] = [];

  for (const file of files) {
    const source = readFileSync(join(ROUTES_DIR, file), "utf8");
    const values = loopValues(source);
    for (const match of source.matchAll(ROUTE_CALL)) {
      const method = match[1]?.toUpperCase() as ScannedMethod;
      const raw = match[2] ?? match[3];
      if (raw === undefined) continue;
      for (const path of expand(raw, values)) {
        routes.push({ method, path: `${API_PREFIX}${path}`, source: file });
      }
    }
  }

  return routes;
}

/** Segment-wise, so a `:param` matches a `:param` of any name. */
function pathsMatch(routePath: string, toolPath: string): boolean {
  const route = routePath.split("/");
  const tool = toolPath.split("/");
  if (route.length !== tool.length) return false;
  return route.every((segment, index) => {
    const other = tool[index] as string;
    if (segment.startsWith(":") && other.startsWith(":")) return true;
    return segment === other;
  });
}

function matches(route: MountedRoute, tool: AgentTool): boolean {
  return route.method === tool.method && pathsMatch(route.path, tool.endpoint);
}

/**
 * Endpoints that exist for the operator's own machinery rather than as a gesture
 * an agent mirrors. Each one is a decision, recorded here so a *new* endpoint
 * cannot join them by being forgotten.
 */
const OPERATOR_ONLY_ROUTES: readonly {
  readonly path: string;
  readonly why: string;
}[] = [
  {
    path: "/api/maintenance/state",
    why: "§12's backup-and-move story: the operator's own machinery for the store they administer, not a gesture agent work mirrors.",
  },
  {
    path: "/api/reset/plan",
    why: "the plan half of a destructive verb (§12). It removes nothing, but it exists to be read by whoever is about to confirm the removal — and that is the operator.",
  },
  {
    path: "/api/reset",
    why: "§12's reset verb. §6.6 already routes destruction of authored state through the operator; an agent emptying the store is not a gesture the product mirrors at all.",
  },
  {
    path: "/api/maintenance/compact",
    why: "the §15-3 sweep on demand: retention is the product's own housekeeping, and the schedule is the operator's setting (§12).",
  },
  {
    path: "/api/runs/:id/pin",
    why: '§4.4: pinning is "the human\'s word for never compact this". A run kept forever because an agent asked would be the retention rule answering to the thing it is meant to bound.',
  },
  {
    path: "/api/budgets",
    why: 'principle 1: a session "cannot wire its own inputs, grant itself capabilities, [or] raise its own budget". Setting a cap is the operator\'s statement about what may be spent — and lowering one is not a gesture the spec asks a session for either — so the write has no tool at all, while the reads (session_budget_read, budgets_read) are §8\'s "a session can see what remains".',
  },
  {
    path: "/api/budgets/:id",
    why: "removing a ceiling is the same operator decision as setting one, from the other side (§8). An agent deleting the budget that bounds it is the exact hole principle 2's transitive guarantee exists to close.",
  },
  {
    path: "/api/approvals",
    why: "\u00a76.6's approvals are the operator's. A session reading the queue of what other sessions are asking for is not a gesture the product mirrors, and the one thing a session needs to know \u2014 how its own blocked call was answered \u2014 reaches it as the tool result, not as a read.",
  },
  {
    path: "/api/approvals/:id",
    why: "the same read, for one approval (\u00a76.6).",
  },
  {
    path: "/api/approvals/:id/answer",
    why: "principle 1: a session answering an approval would be granting itself the capability the approval exists to gate \u2014 `answerApproval` refuses every session author, and there is no tool because there is no gesture.",
  },
  {
    path: "/api/pre-grants",
    why: '\u00a76.6\'s pre-grant is "a human decision about capability made in advance". A session declaring one is principle 1 in advance, and reading the standing decisions that bind it would only tell it which shapes of call to try.',
  },
  {
    path: "/api/pre-grants/:id",
    why: "withdrawing a standing decision is the same operator decision as making one, from the other side (\u00a76.6).",
  },
  {
    path: "/api/attention",
    why: "\u00a77's queue is where the operator decides what to look at. A session reading it would be reading the human's own attention state \u2014 every fact in it is already the session's own record where it is the session's business.",
  },
  {
    path: "/api/attention/:id/acknowledge",
    why: "\u00a74.5's triage verbs are the operator clearing their own queue; a session acknowledging a row would be deciding what the human gets to see.",
  },
  {
    path: "/api/attention/:id/snooze",
    why: "the same, for a snooze (\u00a74.5).",
  },
  {
    path: "/api/attention/:id/mute",
    why: "the same, for a mute (\u00a74.5) \u2014 and the most emphatic of the three, since a muted item never returns.",
  },
  {
    path: "/api/attention/:id/triage",
    why: "undoing a triage decision, which is the operator's for exactly the same reason making one is (\u00a74.5).",
  },
  {
    path: "/api/activity",
    why: '\u00a77.3\'s "what changed while I was away" is written for somebody who was away. Every entry in it is derived from records an agent already has its own reads for.',
  },
  {
    path: "/api/notification-routes",
    why: "\u00a77.3's outbound routes carry attention off this machine to a destination the operator configured. An agent creating one would be choosing where PlotRoom sends notifications, which is not a gesture the product mirrors at any level.",
  },
  {
    path: "/api/notification-routes/:id",
    why: "editing or removing one, for the same reason as creating one (\u00a77.3).",
  },
  {
    path: "/api/plugins",
    why: "\u00a710.2's health surface is a read, and it deliberately has no agent tool: \u00a78 explicitly grants a session sight of what remains of its budget, and no line of the spec grants a session enumeration of what plugins are installed. Inventing that capability would be a product decision nobody asked for \u2014 this declares the read tool-less, never 403-for-sessions, and is revisitable the moment a spec need for it appears.",
  },
  {
    path: "/api/plugins/:id",
    why: "the same read, for one plugin (\u00a710.2).",
  },
  {
    path: "/api/plugins/install",
    why: "principle 1, \u00a710.2: installing a plugin is the operator granting the product new reach. A session installing one would be granting itself capabilities \u2014 the same hole that makes a budget-raising tool impossible.",
  },
  {
    path: "/api/plugins/scan",
    why: "scanning the configured plugins directory is the operator's gesture and never a timer (\u00a710.2, principle 2); a session asking for it would be initiating the discovery of new capability for itself.",
  },
  {
    path: "/api/plugins/:id/enable",
    why: "enabling a plugin makes its contributions reachable (\u00a710.2). A session enabling one is principle 1 again: it cannot grant itself capabilities.",
  },
  {
    path: "/api/plugins/:id/disable",
    why: "the same decision from the other side (\u00a710.2) \u2014 a session disabling a plugin would be deciding what the operator's product can do.",
  },
  {
    path: "/api/plugins/:id",
    why: "removing a plugin forgets the operator's own installation (\u00a710.2, principle 10); it deletes nothing on disk, and it is not a gesture the product mirrors for a session.",
  },
  {
    path: "/api/plugins/:id/grants",
    why: "\u00a710.2's grants are operator-only acts, recorded as such in AGENTS.md: \"there is no agent tool that grants a permission, for the same reason there is none that raises a budget\" (principle 1). A session answering its own plugin's permission request is the silent reach \u00a710.2 rules out.",
  },
  {
    path: "/api/proposals/:id/reject",
    why: "declining a proposal is the operator's word, and it has no tool for the reason accepting one is `humanOnly` (§3.8, principle 1): a session that could decline proposals could decline its own, which is the same reach as accepting them. The refusal reaches the proposing session as feedback, the way an approval denial's does.",
  },
  {
    path: "/api/nodes/:id/position",
    why: "the arrangement is the operator's authored spatial work (§5): an agent rearranging the canvas somebody else is reading is not a wanted gesture, and nothing an agent does depends on where a node sits.",
  },
  {
    path: "/api/arrangement",
    why: "the same as a single position, in bulk (§5) — one drag of a selection is one gesture, and it is the operator's.",
  },
  {
    path: "/api/logs",
    why: "the structured log is the operator's operational record (§8), the same posture /api/log-level already takes for both its verbs; a session's own reasoning needs its budget and its settings, not the process's log.",
  },
  {
    path: "/api/search",
    why: "§6.8's search is the operator's browse/find surface over sessions and archives; no session-facing gesture reads it, so there is no tool to mirror.",
  },
  {
    path: "/api/settings",
    why: "every catalog entry in this batch is humanOnly (§11, principle 1: bind address, credential, concurrency, runtime/workspace defaults) — a session's list read is already filtered to nothing by the route itself, so there is nothing left for a tool to expose.",
  },
  {
    path: "/api/settings/:key",
    why: "same reasoning, per key: a humanOnly setting's own read is refused by actor before this line, matching the write's refusal.",
  },
];

describe("the mounted routes", () => {
  it("are found at all — a silent zero here would make this suite vacuous", () => {
    const routes = mountedRoutes();
    expect(routes.length).toBeGreaterThan(20);
    expect(routes.some((route) => route.path === "/api/workstreams")).toBe(
      true,
    );
    // The templated loop really did expand, rather than being skipped.
    expect(
      routes.some((route) => route.path === "/api/workstreams/:id/archive"),
    ).toBe(true);
    // And a body-write mounted under a verb the catalog cannot express is still
    // found: an unscanned route is a route this suite reports as covered by
    // never having looked at it (§11's settings write is the live example).
    expect(
      routes.some(
        (route) =>
          route.method === "PUT" && route.path === "/api/settings/:key",
      ),
    ).toBe(true);
  });

  it("each have a tool over the same endpoint (principle 8)", () => {
    const tools = liveTools();
    const missing = mountedRoutes().filter(
      (route) =>
        !tools.some((tool) => matches(route, tool)) &&
        !OPERATOR_ONLY_ROUTES.some((entry) =>
          pathsMatch(route.path, entry.path),
        ),
    );
    expect(
      missing.map((route) => `${route.method} ${route.path} (${route.source})`),
    ).toEqual([]);
  });
});

describe("the catalog", () => {
  it("names an endpoint the server actually mounts, for every live tool", () => {
    const routes = mountedRoutes();
    const dangling = liveTools().filter(
      (tool) => !routes.some((route) => matches(route, tool)),
    );
    expect(
      dangling.map((tool) => `${tool.name} → ${tool.method} ${tool.endpoint}`),
    ).toEqual([]);
  });

  it("marks as pending exactly the tools whose endpoint does not exist yet", () => {
    const routes = mountedRoutes();
    const lying = AGENT_TOOL_CATALOG.filter(
      (tool) =>
        tool.availability === "pending" &&
        routes.some((route) => matches(route, tool)),
    );
    // When Track A mounts one of these, this failure is the reminder to flip the
    // flag rather than leaving the vocabulary describing itself as unreachable.
    expect(lying.map((tool) => tool.name)).toEqual([]);
  });

  it("covers the claim tools §3.4 requires sessions to have", () => {
    for (const name of ["claim_request", "claim_yield", "claim_inspect"]) {
      expect(toolByName(name), name).toBeDefined();
    }
  });

  it("lets an agent read graph warnings (§5)", () => {
    const warnings = toolByName("graph_warnings_read");
    expect(warnings?.method).toBe("GET");
    expect(warnings?.requires.mutates).toBe(false);
  });

  it("keeps the operator's own gestures out of what a session may call", () => {
    const callable = sessionCallableTools().map((tool) => tool.name);
    for (const name of [
      "claim_grant",
      "claim_force_release",
      "proposal_accept",
      "log_level_set",
    ]) {
      expect(toolByName(name)?.requires.humanOnly, name).toBe(true);
      expect(callable).not.toContain(name);
    }
  });

  it("has unique names and well-formed declarations", () => {
    const names = AGENT_TOOL_CATALOG.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);

    for (const tool of AGENT_TOOL_CATALOG) {
      expect(tool.name, tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.endpoint, tool.name).toMatch(/^\/api\//);
      expect(tool.summary.length, tool.name).toBeGreaterThan(10);
      expect(tool.gesture.length, tool.name).toBeGreaterThan(3);
      for (const field of Object.values(tool.input)) {
        expect(TOOL_INPUT_TYPES, tool.name).toContain(field.type);
        expect(field.description.length, tool.name).toBeGreaterThan(0);
      }
      // Every path parameter is declared as an input, or the bridge could not
      // address the endpoint at all.
      for (const parameter of pathParametersOf(tool.endpoint)) {
        expect(tool.input[parameter]?.inPath, `${tool.name}.${parameter}`).toBe(
          true,
        );
      }
      // A GET that claims to mutate, or a mutation that claims not to, would make
      // the requirement flags unusable for deciding approvals.
      expect(tool.requires.mutates, tool.name).toBe(tool.method !== "GET");
    }
  });

  it("gives every destruction tool exactly one path parameter to name its target", () => {
    // The destruction guard (`apps/server/src/approvals/guard.ts`) addresses a
    // session's destructive call by the **one** path parameter its endpoint
    // names: that parameter is the record §6.6 asks the operator about. A tool
    // with none has no target to name in the row, and one with two has no single
    // target at all — either way the guard cannot address it, and the route ships
    // enforced by nothing.
    //
    // Pinned here rather than left to the guard's own skip, because the failure
    // mode of that skip is silence: a new destructive verb declared with an
    // awkward endpoint would simply stop being routed through approvals, and
    // nothing downstream would say so.
    for (const tool of destructionTools()) {
      expect(pathParametersOf(tool.endpoint), tool.name).toHaveLength(1);
      expect(tool.method, tool.name).not.toBe("GET");
    }
    // And there really are some, so this cannot pass by matching nothing.
    expect(destructionTools().length).toBeGreaterThan(0);
  });

  it("states how every lineage-checked tool's target must resolve", () => {
    // The mounting contract as data rather than prose someone may not read: a
    // resolution nobody wrote down is a refusal that fires on the wrong calls,
    // which is how a principle-1 check becomes either advisory or obstructive.
    const checked = AGENT_TOOL_CATALOG.filter((tool) =>
      ["target-session", "capability", "budget"].includes(
        tool.requires.reflexivity,
      ),
    );
    expect(checked.length).toBeGreaterThan(5);
    const undeclared = checked.filter(
      (tool) => (tool.requires.targetResolution ?? "").length < 20,
    );
    expect(undeclared.map((tool) => tool.name)).toEqual([]);
  });

  it("makes §4.1 expressible for dispatch, and keeps claims exempt (§3.4)", () => {
    const dispatch = toolByName("run_one");
    expect(dispatch?.requires.reflexivity).toBe("target-session");
    expect(dispatch?.requires.targetResolution).toContain("already run");
    // The trap: resolving a dispatch to its own new child would refuse every
    // delegation the spec permits, so the contract says so in capitals.
    expect(dispatch?.requires.targetResolution).toContain("NEVER");

    for (const name of [
      "claim_answer",
      "claim_policy_declare",
      "claim_policy_withdraw",
    ]) {
      expect(toolByName(name)?.requires.targetResolution, name).toContain(
        "empty set",
      );
    }
  });

  it("splits §3.8's standing instructions the way principle 1 does", () => {
    // Marking content standing applies it to the caller's own chain, so it is a
    // proposal; opting *a workstream* in is ordinary authoring into that workstream,
    // so it is lineage-checked with a resolution stated as data.
    for (const name of [
      "standing_instruction_declare",
      "standing_instruction_retire",
    ]) {
      expect(toolByName(name)?.requires.reflexivity, name).toBe(
        "self-proposal",
      );
      expect(toolByName(name)?.requires.humanOnly, name).toBe(false);
    }
    for (const name of [
      "workstream_standing_instructions_opt_in",
      "workstream_standing_instructions_opt_out",
    ]) {
      expect(toolByName(name)?.requires.reflexivity, name).toBe(
        "target-session",
      );
      expect(toolByName(name)?.requires.targetResolution, name).toContain(
        "workstream feeds",
      );
    }
    // A session can see what it is running under; rediscovering it costs a turn.
    expect(toolByName("standing_instruction_list")?.requires.humanOnly).toBe(
      false,
    );
  });

  it("declares a claim requirement on the tools that name a workspace path", () => {
    const claiming = AGENT_TOOL_CATALOG.filter(
      (tool) => tool.requires.claimOnInput !== undefined,
    );
    expect(claiming.map((tool) => tool.name)).toContain("claim_request");
    for (const tool of claiming) {
      expect(
        tool.input[tool.requires.claimOnInput as string],
        tool.name,
      ).toBeDefined();
    }
  });
});
