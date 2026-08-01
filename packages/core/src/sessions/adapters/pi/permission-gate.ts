import type { RequestOutcome, RuntimeRequest } from "../../runtime.js";
import type { PiCommand, PiEvent } from "./protocol.js";

/**
 * C6 for pi (decision 0001): "approvals (§6.6) and path claims (§3.4) gate the
 * runtime rather than advise it."
 *
 * pi has no single blessed per-call permission callback, so the gate is built
 * on its extension tool layer: a `tool_call` handler runs before every tool,
 * can block it with a reason, and — pi's documented behaviour — a handler that
 * throws blocks the tool too, so the gate is fail-safe. In RPC mode
 * `ctx.ui.confirm` becomes an `extension_ui_request` on stdout that blocks
 * until PlotRoom answers on stdin, which puts the host in the decision path per
 * call, exactly like the Claude SDK's `canUseTool`.
 *
 * Verified against pi 0.83.0 before anything depended on it: with this
 * extension loaded, a denied `bash` tool call produced no side effect and the
 * model received an error result; without it, the same call ran. See
 * `permission-gate.spike.test.ts`.
 */
export const PI_APPROVAL_TITLE_PREFIX = "plotroom-approval:";
export const PI_QUESTION_TITLE_PREFIX = "plotroom-question:";

/**
 * The extension PlotRoom loads into every pi session (`pi -e <file>`). Shipped
 * as source because it runs inside pi's process, not PlotRoom's; the server
 * writes it beside the session and passes the path.
 */
export const PI_PERMISSION_GATE_EXTENSION = `/**
 * PlotRoom permission gate — generated, do not edit.
 *
 * Every tool call is decided by PlotRoom before it runs (§6.6 approvals, §3.4
 * path claims). No host answer, no tool call: a gate that fails open is advice.
 */
export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    if (!ctx.hasUI) {
      return { block: true, reason: "PlotRoom is not attached; tool calls are refused" };
    }

    const allowed = await ctx.ui.confirm(
      "${PI_APPROVAL_TITLE_PREFIX}" + event.toolName,
      JSON.stringify(event.input ?? {}),
    );

    return allowed ? undefined : { block: true, reason: "refused by PlotRoom" };
  });
}
`;

export interface ParsedRuntimeRequest {
  readonly requestId: string;
  readonly request: RuntimeRequest;
}

/**
 * Recognize a gate request in pi's UI sub-protocol. Anything else an extension
 * asks for is not PlotRoom's to answer, and is left alone.
 */
export function parseGateRequest(event: PiEvent): ParsedRuntimeRequest | null {
  if (event.type !== "extension_ui_request") return null;
  const title = event.title ?? "";

  if (
    event.method === "confirm" &&
    title.startsWith(PI_APPROVAL_TITLE_PREFIX)
  ) {
    return {
      requestId: event.id,
      request: {
        kind: "tool-permission",
        toolName: title.slice(PI_APPROVAL_TITLE_PREFIX.length),
        input: parseJson(event.message),
      },
    };
  }

  if (event.method === "select" && title.startsWith(PI_QUESTION_TITLE_PREFIX)) {
    return {
      requestId: event.id,
      request: {
        kind: "question",
        text: title.slice(PI_QUESTION_TITLE_PREFIX.length),
        options: event.options ?? [],
      },
    };
  }

  return null;
}

/** PlotRoom's answer, in pi's words. A denial is a block, not a hint. */
export function encodeRequestOutcome(
  requestId: string,
  outcome: RequestOutcome,
): PiCommand {
  switch (outcome.kind) {
    case "allow":
      return { type: "extension_ui_response", id: requestId, confirmed: true };
    case "deny":
      return { type: "extension_ui_response", id: requestId, confirmed: false };
    case "answer":
      return {
        type: "extension_ui_response",
        id: requestId,
        value: outcome.value,
      };
  }
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
