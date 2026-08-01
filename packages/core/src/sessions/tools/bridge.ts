import { sessionAuthor, type Author } from "../../author.js";
import type { SessionId } from "../../ids.js";
import type { LineageIndex } from "../../lineage.js";
import {
  pathParametersOf,
  toolByName,
  type AgentTool,
  type HttpMethod,
} from "./catalog.js";
import {
  checkToolCall,
  type ToolCall,
  type ToolCallRefusal,
  type ToolTargetIndex,
} from "./reflexivity.js";

/**
 * The session tool bridge (Epic 4.5, and the plan's carry-over fix).
 *
 * The Epic 2.2 review recorded the hole: `X-PlotRoom-Actor` is caller-supplied,
 * so "when agent tools land, the tool/runtime layer must set the actor itself
 * from the session it serves — never trust an agent-supplied actor — or principle
 * 1 becomes advisory."
 *
 * This is that layer, and the fix is structural rather than a rule: a bridge is
 * **constructed with the session it serves**, the actor header is written from
 * that binding on every request, and an input carrying anything actor-shaped is
 * *refused* rather than stripped. A session has no way to say who it is, so it
 * has no way to say it is someone else. The tool schema (`catalog.ts`) declares no
 * actor field either, so a well-behaved agent never even tries.
 *
 * Transport is injected: `core` builds requests, it does not make them.
 */

export const ACTOR_HEADER_NAME = "X-PlotRoom-Actor";

export function sessionActorHeaderValue(sessionId: SessionId): string {
  return `session:${sessionId}`;
}

/**
 * Input keys a session may never supply. Refused, not ignored: an agent that
 * tried to set the actor is either confused or attacking, and quietly dropping
 * the field teaches it that the call worked.
 */
export const RESERVED_INPUT_KEYS: readonly string[] = [
  "actor",
  "author",
  "authorId",
  "author_id",
  "x-plotroom-actor",
  "xPlotroomActor",
  "headers",
  "credential",
];

export interface SessionToolBinding {
  readonly sessionId: SessionId;
  /** Which runtime adapter serves this session, for logs and accounting. */
  readonly adapterId?: string;
}

export interface ToolHttpRequest {
  readonly method: HttpMethod;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, unknown>> | null;
}

export const TOOL_REQUEST_REFUSAL_REASONS = [
  "unknown_tool",
  /** The session tried to declare an actor, an author, or headers. */
  "actor_supplied_by_session",
  "missing_input",
  "unknown_input",
] as const;

export type ToolRequestRefusalReason =
  (typeof TOOL_REQUEST_REFUSAL_REASONS)[number];

export interface ToolRequestRefusal {
  readonly reason: ToolRequestRefusalReason;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export type ToolRequestBuild =
  | {
      readonly ok: true;
      readonly request: ToolHttpRequest;
      readonly tool: AgentTool;
    }
  | { readonly ok: false; readonly refusal: ToolRequestRefusal };

/**
 * Turn a tool call into the HTTP request the server already serves — the same
 * endpoint the canvas calls, with the actor the bridge knows rather than the one
 * the agent claims.
 */
export function buildToolRequest(
  binding: SessionToolBinding,
  call: ToolCall,
): ToolRequestBuild {
  const tool = toolByName(call.tool);
  if (tool === undefined) {
    return refuse("unknown_tool", `no tool named ${JSON.stringify(call.tool)}`);
  }

  for (const key of Object.keys(call.input)) {
    if (RESERVED_INPUT_KEYS.includes(key)) {
      return refuse(
        "actor_supplied_by_session",
        `a session does not supply ${key}: attribution is set by the bridge from the session it serves`,
        { key },
      );
    }
    if (!(key in tool.input)) {
      return refuse(
        "unknown_input",
        `${tool.name} takes no input named ${key}`,
        {
          key,
          accepts: Object.keys(tool.input),
        },
      );
    }
  }

  for (const [key, field] of Object.entries(tool.input)) {
    if (field.required && call.input[key] === undefined) {
      return refuse(
        "missing_input",
        `${tool.name} requires ${key}: ${field.description}`,
        {
          key,
        },
      );
    }
  }

  let path = tool.endpoint;
  for (const parameter of pathParametersOf(tool.endpoint)) {
    const value = call.input[parameter];
    if (value === undefined || value === null || String(value).length === 0) {
      return refuse(
        "missing_input",
        `${tool.name} needs ${parameter} to address ${tool.endpoint}`,
        { parameter },
      );
    }
    path = path.replace(`:${parameter}`, encodeURIComponent(String(value)));
  }

  const pathKeys = new Set(pathParametersOf(tool.endpoint));
  const rest = Object.entries(call.input).filter(([key]) => !pathKeys.has(key));

  const isRead = tool.method === "GET";
  const query: Record<string, string> = {};
  const body: Record<string, unknown> = {};
  for (const [key, value] of rest) {
    if (value === undefined) continue;
    if (isRead) query[key] = String(value);
    else body[key] = value;
  }

  return {
    ok: true,
    tool,
    request: {
      method: tool.method,
      path,
      // The one place the actor is set, from the binding — never from input.
      headers: {
        [ACTOR_HEADER_NAME]: sessionActorHeaderValue(binding.sessionId),
        ...(isRead ? {} : { "Content-Type": "application/json" }),
      },
      query,
      body: isRead || Object.keys(body).length === 0 ? null : body,
    },
  };
}

function refuse(
  reason: ToolRequestRefusalReason,
  message: string,
  details?: Record<string, unknown>,
): ToolRequestBuild {
  return {
    ok: false,
    refusal:
      details === undefined
        ? { reason, message }
        : { reason, message, details },
  };
}

/* --------------------------------------------------------------- the bridge */

export interface ToolHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

/** Injected: `core` builds requests and reads answers; it owns no transport. */
export interface ToolTransport {
  send(request: ToolHttpRequest): Promise<ToolHttpResponse>;
}

export interface SessionToolBridgeOptions {
  readonly binding: SessionToolBinding;
  readonly transport: ToolTransport;
  readonly lineage: LineageIndex;
  readonly targets?: ToolTargetIndex;
}

export type ToolCallOutcome =
  | { readonly ok: true; readonly response: ToolHttpResponse }
  | {
      readonly ok: false;
      readonly refusal: ToolCallRefusal | ToolRequestRefusal;
    };

export interface SessionToolBridge {
  readonly actor: Author;
  call(call: ToolCall): Promise<ToolCallOutcome>;
}

/**
 * Every call the session makes goes: reflexivity check (principle 1) → request
 * build (actor set here) → transport. A refusal never reaches the transport, so a
 * refused call has no chance of a side effect.
 */
export function createSessionToolBridge(
  options: SessionToolBridgeOptions,
): SessionToolBridge {
  const actor = sessionAuthor(options.binding.sessionId);

  return {
    actor,
    async call(call: ToolCall): Promise<ToolCallOutcome> {
      const permitted = checkToolCall(
        {
          actor,
          lineage: options.lineage,
          ...(options.targets ? { targets: options.targets } : {}),
        },
        call,
      );
      if (!permitted.allowed) return { ok: false, refusal: permitted.refusal };

      const built = buildToolRequest(options.binding, call);
      if (!built.ok) return { ok: false, refusal: built.refusal };

      return {
        ok: true,
        response: await options.transport.send(built.request),
      };
    },
  };
}
