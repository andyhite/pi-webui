import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeLaunchChoices } from "../../testing.js";
import { buildPiArgs } from "./adapter.js";
import {
  PI_APPROVAL_TITLE_PREFIX,
  PI_PERMISSION_GATE_EXTENSION,
} from "./permission-gate.js";
import { parsePiEvent, splitJsonLines } from "./protocol.js";

/**
 * C6 verification (decision 0001): "pi's per-call permission gating is verified
 * early in adapter v1 — approvals (§6.6) and claims (§3.4) must be enforced,
 * not advised; if pi's tool layer cannot enforce them, adapter order reverts to
 * the Claude Agent SDK."
 *
 * This is that verification, kept runnable rather than written up: a real pi
 * process, the real gate extension from `permission-gate.ts`, and a mock
 * OpenAI-compatible endpoint that deterministically asks for a `bash` call with
 * an observable side effect. The gate's decision is made out of process, by
 * this test standing in for PlotRoom, over pi's RPC UI sub-protocol.
 *
 * Opt-in, because it needs pi on PATH:
 *
 *     PLOTROOM_PI_SPIKE=1 pnpm --filter @plotroom/core test
 */
const ENABLED = process.env.PLOTROOM_PI_SPIKE === "1";

const MARKER = "TOOL_RAN";

let workdir = "";
let server: Server | undefined;
let baseUrl = "";

beforeAll(async () => {
  if (!ENABLED) return;
  workdir = mkdtempSync(join(tmpdir(), "plotroom-pi-spike-"));

  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      // The first call asks for the tool; once a tool result comes back, stop.
      const wantsTool = !body.includes('"role":"tool"');
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const chunk of wantsTool
        ? toolCallChunks(join(workdir, MARKER))
        : finalChunks()) {
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });

  await new Promise<void>((resolve) => {
    server?.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1`;

  writeFileSync(join(workdir, "provider.ts"), providerExtension(baseUrl));
  writeFileSync(join(workdir, "gate.ts"), PI_PERMISSION_GATE_EXTENSION);
});

afterAll(() => {
  server?.close();
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

describe.skipIf(!ENABLED)("C6: pi enforces PlotRoom's tool decisions", () => {
  it("runs the tool when nothing gates it (the control)", async () => {
    const result = await runPi({ gate: false, answer: "allow" });

    expect(result.toolEnded?.isError).toBe(false);
    expect(existsSync(join(workdir, MARKER))).toBe(true);
  }, 60_000);

  it("blocks the tool when PlotRoom denies it, with no side effect", async () => {
    const result = await runPi({ gate: true, answer: "deny" });

    expect(result.approvalTitles).toEqual([`${PI_APPROVAL_TITLE_PREFIX}bash`]);
    // pi reports the block to the model as an error result; the tool never ran.
    expect(result.toolEnded?.isError).toBe(true);
    expect(existsSync(join(workdir, MARKER))).toBe(false);
  }, 60_000);

  it("runs the tool when PlotRoom allows it", async () => {
    const result = await runPi({ gate: true, answer: "allow" });

    expect(result.approvalTitles).toHaveLength(1);
    expect(result.toolEnded?.isError).toBe(false);
    expect(existsSync(join(workdir, MARKER))).toBe(true);
  }, 60_000);
});

interface SpikeResult {
  readonly approvalTitles: readonly string[];
  readonly toolEnded: { readonly isError: boolean } | null;
}

async function runPi(options: {
  gate: boolean;
  answer: "allow" | "deny";
}): Promise<SpikeResult> {
  rmSync(join(workdir, MARKER), { force: true });

  const extensionPaths = [join(workdir, "provider.ts")];
  if (options.gate) extensionPaths.push(join(workdir, "gate.ts"));

  const args = [
    ...buildPiArgs({
      mode: "start",
      launch: makeLaunchChoices({
        model: "mock-model",
        effort: "off",
        toolPermissions: { allowedTools: null },
      }),
      workspacePath: workdir,
      extensionPaths,
    }),
    "--provider",
    "mockprov",
    "--no-session",
    "--no-extensions",
  ];

  const child = spawn("pi", args, { cwd: workdir });
  const approvalTitles: string[] = [];
  let toolEnded: { isError: boolean } | null = null;

  await new Promise<void>((resolve) => {
    let buffer = "";
    const finish = () => {
      child.kill();
      resolve();
    };
    const timer = setTimeout(finish, 45_000);

    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      const { lines, rest } = splitJsonLines(buffer);
      buffer = rest;

      for (const line of lines) {
        const event = parsePiEvent(line);
        if (event.type === "extension_ui_request") {
          approvalTitles.push(event.title ?? "");
          child.stdin.write(
            `${JSON.stringify({
              type: "extension_ui_response",
              id: event.id,
              confirmed: options.answer === "allow",
            })}\n`,
          );
        }
        if (event.type === "tool_execution_end") {
          toolEnded = { isError: event.isError ?? false };
        }
        if (event.type === "agent_settled") {
          clearTimeout(timer);
          finish();
        }
      }
    });

    child.stdin.write(
      `${JSON.stringify({ id: "p1", type: "prompt", message: "use the bash tool" })}\n`,
    );
  });

  return { approvalTitles, toolEnded };
}

function providerExtension(url: string): string {
  return `export default function (pi) {
  pi.registerProvider("mockprov", {
    name: "Mock Provider",
    baseUrl: ${JSON.stringify(url)},
    apiKey: "mock-key",
    api: "openai-completions",
    models: [
      {
        id: "mock-model",
        name: "Mock Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  });
}
`;
}

const BASE_CHUNK = {
  id: "chatcmpl-mock",
  object: "chat.completion.chunk",
  created: 1,
  model: "mock-model",
};

function toolCallChunks(markerPath: string): readonly unknown[] {
  return [
    {
      ...BASE_CHUNK,
      choices: [
        { index: 0, delta: { role: "assistant" }, finish_reason: null },
      ],
    },
    {
      ...BASE_CHUNK,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_mock_1",
                type: "function",
                function: { name: "bash", arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      ...BASE_CHUNK,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: JSON.stringify({ command: `touch ${markerPath}` }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      ...BASE_CHUNK,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ];
}

function finalChunks(): readonly unknown[] {
  return [
    {
      ...BASE_CHUNK,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "done" },
          finish_reason: null,
        },
      ],
    },
    {
      ...BASE_CHUNK,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
    },
  ];
}
