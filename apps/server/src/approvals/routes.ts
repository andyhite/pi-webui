import { pathParametersOf, type AgentTool } from "@plotroom/core";
import type { Logger } from "../logging/logger.js";

/**
 * Addressing a live request as a catalog tool, in one place.
 *
 * Two middlewares gate a session's calls by what the catalog declares about them
 * — `destructionGuard` (§6.6) and `sessionLineageGuard` (principle 1) — and both
 * need the same thing: the tools they cover turned into route patterns once, and
 * an incoming method plus path matched back to one of them and to the record it
 * names. A second implementation of that matching is a second answer to "which
 * route is this", and the two guards would eventually disagree about a call.
 *
 * The shape both rely on is that a covered tool declares **exactly one** path
 * parameter — the record it acts on. A tool with none names no target, and one
 * with two names no single target; either way it cannot be addressed here, so it
 * is skipped and **named in the log at construction**, once, at error level: the
 * honest report of a route that is now enforced by nothing. A boot-time throw
 * would take the whole server down over one malformed declaration, which is worse
 * — but silence would be worse still, which is why each caller also pins its own
 * set in `catalog.test.ts`.
 */
export interface ToolRoute {
  readonly tool: AgentTool;
  readonly segments: readonly string[];
  readonly idIndex: number;
}

export interface MatchedTool {
  readonly tool: AgentTool;
  readonly targetId: string;
}

/**
 * @param why the sentence the log carries for a tool this cannot address — the
 * calling guard's own reason, because "not guarded" means something different to
 * each of them.
 */
export function toolRoutes(
  tools: readonly AgentTool[],
  logger: Logger,
  why: string,
): readonly ToolRoute[] {
  const routes: ToolRoute[] = [];

  for (const tool of tools) {
    const segments = tool.endpoint.split("/");
    const parameters = pathParametersOf(tool.endpoint);
    const idIndex = segments.findIndex((segment) => segment.startsWith(":"));

    if (parameters.length !== 1 || idIndex < 0) {
      logger.error("a tool route cannot be addressed", {
        tool: tool.name,
        endpoint: tool.endpoint,
        pathParameters: parameters.length,
        why,
      });
      continue;
    }

    routes.push({ tool, segments, idIndex });
  }

  return routes;
}

export function matchToolRoute(
  routes: readonly ToolRoute[],
  method: string,
  path: string,
): MatchedTool | null {
  const segments = path.split("/");

  for (const route of routes) {
    if (route.tool.method !== method) continue;
    if (route.segments.length !== segments.length) continue;
    const matches = route.segments.every(
      (segment, index) =>
        segment.startsWith(":") || segment === segments[index],
    );
    if (!matches) continue;

    const targetId = segments[route.idIndex];
    if (targetId === undefined || targetId.length === 0) continue;
    return { tool: route.tool, targetId };
  }

  return null;
}
