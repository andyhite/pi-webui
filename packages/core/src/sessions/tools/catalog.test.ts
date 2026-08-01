import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AGENT_TOOL_CATALOG,
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

interface MountedRoute {
  readonly method: HttpMethod;
  /** With `/api` prepended, and every `${...}` expanded to the literal it loops over. */
  readonly path: string;
  readonly source: string;
}

const ROUTE_CALL = /app\.(get|post|patch|delete)\(\s*(?:"([^"]+)"|`([^`]+)`)/g;

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
      const method = match[1]?.toUpperCase() as HttpMethod;
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
}[] = [];

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
    const dispatch = toolByName("session_dispatch");
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
