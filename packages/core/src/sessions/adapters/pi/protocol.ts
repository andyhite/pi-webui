/**
 * pi's RPC surface, as much of it as PlotRoom consumes (decision 0001, adapter
 * v1). pi speaks JSON objects over stdin/stdout, one per line.
 *
 * This file is the only place vendor field names appear. Everything downstream
 * reads `RuntimeObservation`, so a pi release that renames an event costs one
 * mapping change and no session records.
 */

/**
 * pi documents strict JSONL with LF as the only record delimiter, and warns
 * that Node's `readline` is not protocol-compliant because it also splits on
 * U+2028/U+2029 — which are legal inside JSON strings. So framing is ours.
 */
export function splitJsonLines(buffer: string): {
  readonly lines: readonly string[];
  readonly rest: string;
} {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return {
    lines: parts
      .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
      .filter((line) => line.trim().length > 0),
    rest,
  };
}

export interface PiUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly cost?: { readonly total?: number };
}

/**
 * pi streams many delta kinds (`text_delta`, `thinking_delta`, tool-call
 * deltas, start/end markers). Only the two carrying content matter here, and
 * `delta` is optional because the markers have none.
 */
export interface PiAssistantDelta {
  readonly type: string;
  readonly delta?: string;
}

export type PiEvent =
  | { readonly type: "agent_start" }
  | { readonly type: "agent_settled" }
  | { readonly type: "turn_start" }
  | {
      readonly type: "turn_end";
      readonly message?: { readonly usage?: PiUsage };
    }
  | {
      readonly type: "message_update";
      readonly assistantMessageEvent?: PiAssistantDelta;
    }
  | {
      readonly type: "tool_execution_start";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args?: unknown;
    }
  | {
      readonly type: "tool_execution_end";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly result?: unknown;
      readonly isError?: boolean;
    }
  | { readonly type: "compaction_start"; readonly reason?: string }
  | { readonly type: "compaction_end"; readonly aborted?: boolean }
  | {
      readonly type: "queue_update";
      readonly steering?: readonly string[];
      readonly followUp?: readonly string[];
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: string;
      readonly title?: string;
      readonly message?: string;
      readonly options?: readonly string[];
    }
  | { readonly type: "extension_error"; readonly error?: string }
  | {
      readonly type: "response";
      readonly id?: string;
      readonly command: string;
      readonly success: boolean;
      readonly error?: string;
      readonly data?: unknown;
    }
  | { readonly type: "unknown" };

const CONSUMED_EVENT_TYPES = new Set([
  "agent_start",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_update",
  "tool_execution_start",
  "tool_execution_end",
  "compaction_start",
  "compaction_end",
  "queue_update",
  "extension_ui_request",
  "extension_error",
  "response",
]);

/**
 * Parse one JSONL record. A line PlotRoom cannot read is `unknown`, never a
 * throw: an adapter that crashes on an unrecognized event would take the
 * session with it, and pi adds events between releases.
 */
export function parsePiEvent(line: string): PiEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { type: "unknown" };
  }

  if (typeof value !== "object" || value === null) return { type: "unknown" };
  const record = value as { type?: unknown };
  if (typeof record.type !== "string") return { type: "unknown" };
  if (!CONSUMED_EVENT_TYPES.has(record.type)) return { type: "unknown" };

  return value as PiEvent;
}

/* ------------------------------------------------------------------ commands */

export type PiCommand =
  | {
      readonly type: "prompt";
      readonly id: string;
      readonly message: string;
      /**
       * Absent for a session's first prompt. `"steer"` for every injection: pi
       * refuses a bare prompt while it is streaming, and its standalone `steer`
       * command queues *without triggering a turn* when it is idle — so a prompt
       * carrying this field is the only shape that actually delivers in both
       * states (§6.5; verified against pi 0.83.0's `AgentSession.prompt`).
       */
      readonly streamingBehavior?: "steer" | "followUp";
    }
  | { readonly type: "steer"; readonly id: string; readonly message: string }
  | { readonly type: "abort"; readonly id: string }
  | { readonly type: "get_session_stats"; readonly id: string }
  | { readonly type: "get_fork_messages"; readonly id: string }
  | { readonly type: "fork"; readonly id: string; readonly entryId: string }
  | {
      readonly type: "extension_ui_response";
      readonly id: string;
      readonly confirmed?: boolean;
      readonly value?: string;
      readonly cancelled?: boolean;
    };

export function encodeCommand(command: PiCommand): string {
  return `${JSON.stringify(command)}\n`;
}
