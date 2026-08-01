import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type {
  RuntimeObservation,
  RuntimeSessionHandle,
  SessionRuntimeAdapter,
} from "../../runtime.js";
import { makeLaunchChoices } from "../../testing.js";
import {
  buildPiArgs,
  createPiAdapter,
  type PiLaunchOptions,
  type PiRpcTransport,
} from "./adapter.js";

/**
 * Injection and fork, against a real pi (§6.5, §6.3).
 *
 * The C6 spike (`permission-gate.spike.test.ts`) proved a decision PlotRoom could
 * not take on documentation alone; these two are the same kind of claim. Both are
 * things the adapter asserts about pi's behaviour that a replayed transport cannot
 * check, because a fake answers however the fake was written:
 *
 * 1. **An injection into a live-but-idle session actually arrives.** pi's
 *    standalone `steer` command queues without triggering a turn, so an
 *    injection sent that way is "queued" forever — the exact failure §6.5 exists
 *    to prevent. `inject()` sends a `prompt` carrying `streamingBehavior: "steer"`
 *    instead. This spike runs both and shows the difference in pi's own events.
 * 2. **A fork at turn `n` inherits turns 1..n, inclusively** (§6.3), which
 *    depends on `resolvePiForkTarget`'s arithmetic against pi's *actual* fork
 *    message list rather than against an assumption about it.
 *
 * Opt-in, because it needs pi on PATH:
 *
 *     PLOTROOM_PI_SPIKE=1 pnpm --filter @plotroom/core test
 *
 * The model is a mock OpenAI-compatible endpoint that answers every request with
 * one line of text and records what it was sent, so "did the injected text reach
 * the model" is a fact this test can read rather than infer.
 */
const ENABLED = process.env.PLOTROOM_PI_SPIKE === "1";

let workdir = "";
let server: Server | undefined;
let baseUrl = "";
/** Every request the mock model received, as its user-message texts. */
let seenRequests: string[][] = [];
const running: ChildProcessWithoutNullStreams[] = [];
const transports: PiRpcTransport[] = [];

beforeAll(async () => {
  if (!ENABLED) return;
  workdir = mkdtempSync(join(tmpdir(), "plotroom-pi-steering-"));

  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      seenRequests.push(userTexts(body));
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const chunk of textChunks("ok")) {
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
  baseUrl = `http://127.0.0.1:${
    typeof address === "object" && address ? address.port : 0
  }/v1`;

  writeFileSync(join(workdir, "provider.ts"), providerExtension(baseUrl));
});

afterEach(() => {
  seenRequests = [];
});

afterAll(() => {
  for (const child of running) child.kill();
  server?.close();
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

describe.skipIf(!ENABLED)("injection reaches a live pi session (§6.5)", () => {
  it("delivers into an idle session, where a bare steer would not", async () => {
    const sessionId = `plotroom-idle-${Date.now()}`;
    const adapter = adapterFor(sessionId);
    const handle = await adapter.start({
      prompt: "say ok",
      launch: launch(),
      workspacePath: workdir,
    });

    await settled(handle);
    const beforeInjection = seenRequests.length;
    // The first prompt did reach the model, so the control below is a real
    // control rather than a test that never talked to anything.
    expect(beforeInjection).toBeGreaterThan(0);

    // The control: pi's own `steer`, straight down the transport PlotRoom would
    // otherwise have used. It is accepted, and nothing happens — no turn, no
    // request to the model.
    lastTransport()?.write(
      `${JSON.stringify({ id: "s1", type: "steer", message: "steered while idle" })}\n`,
    );
    await pause(1_500);
    expect(seenRequests.length).toBe(beforeInjection);

    // What PlotRoom actually sends. This one arrives.
    const receipt = await handle.inject({
      id: "inj-1",
      text: "injected while idle",
    });
    expect(receipt.id).toBe("inj-1");

    const observations = await settled(handle);
    expect(observations.map((observation) => observation.kind)).toContain(
      "turn-started",
    );
    expect(observations.map((observation) => observation.kind)).toContain(
      "injection-delivered",
    );

    const latest = seenRequests.at(-1) ?? [];
    expect(latest.join("\n")).toContain("injected while idle");

    await handle.stop("abort");
  }, 90_000);
});

describe.skipIf(!ENABLED)("fork inherits an inclusive prefix (§6.3)", () => {
  it("forks at turn 1 and inherits turn 1, not turn 2", async () => {
    const sessionId = `plotroom-fork-${Date.now()}`;
    const adapter = adapterFor(sessionId);
    const source = await adapter.start({
      prompt: "FIRST TURN",
      launch: launch(),
      workspacePath: workdir,
    });
    await settled(source);
    // A second turn, made the way PlotRoom makes one into a live session.
    await source.inject({ id: "inj-second", text: "SECOND TURN" });
    await settled(source);
    await source.stop("abort");

    const forked = await adapter.fork(
      sessionId,
      { turn: 1 },
      {
        prompt: "THIRD TURN",
        launch: launch(),
        workspacePath: workdir,
      },
    );
    await settled(forked);

    const latest = (seenRequests.at(-1) ?? []).join("\n");
    // The fork inherited turn 1 and dropped turn 2 — the inclusive rule, proven
    // against what the model was actually sent.
    expect(latest).toContain("FIRST TURN");
    expect(latest).toContain("THIRD TURN");
    expect(latest).not.toContain("SECOND TURN");

    await forked.stop("abort");
  }, 120_000);
});

/* ------------------------------------------------------------------ harness */

function launch() {
  return makeLaunchChoices({
    model: "mock-model",
    effort: "off",
    toolPermissions: { allowedTools: null },
  });
}

function adapterFor(sessionId: string): SessionRuntimeAdapter {
  return createPiAdapter({
    connect: async (options) => connect(options, sessionId),
    now: () => Date.now(),
  });
}

/** The most recent pi process's transport, for the control experiment above. */
function lastTransport(): PiRpcTransport | undefined {
  return transports.at(-1);
}

async function connect(
  options: PiLaunchOptions,
  sessionId: string,
): Promise<PiRpcTransport> {
  const args = [
    ...buildPiArgs({
      ...options,
      extensionPaths: [join(workdir, "provider.ts")],
    }),
    "--provider",
    "mockprov",
    "--no-extensions",
    "--session-dir",
    workdir,
  ];
  // A known session id is what makes `--fork <ref>` addressable from the test.
  if (options.mode === "start") args.push("--session-id", sessionId);

  const child = spawn("pi", args, { cwd: workdir });
  running.push(child);

  const transport: PiRpcTransport = {
    // pi's fork of a session file is addressed by the source id; for `start`
    // that is the id we asked for.
    ref: options.mode === "start" ? sessionId : (options.ref ?? sessionId),
    write: (line) => child.stdin.write(line),
    chunks: () => child.stdout as unknown as AsyncIterable<string>,
    close: async () => {
      child.kill();
    },
  };
  transports.push(transport);
  return transport;
}

/** Drain observations until pi settles, or until the budget runs out. */
async function settled(
  handle: RuntimeSessionHandle,
  budgetMillis = 30_000,
): Promise<readonly RuntimeObservation[]> {
  const observations: RuntimeObservation[] = [];
  const deadline = Date.now() + budgetMillis;

  const iterator = handle.observations()[Symbol.asyncIterator]();
  while (Date.now() < deadline) {
    const next = await Promise.race([
      iterator.next(),
      pause(2_000).then(() => "timeout" as const),
    ]);
    if (next === "timeout") break;
    if (next.done) break;
    observations.push(next.value);
    if (next.value.kind === "turn-ended") break;
  }
  // pi keeps streaming after a turn; a short settle window keeps the next
  // assertion from racing the model's own request.
  await pause(500);
  return observations;
}

function pause(millis: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, millis));
}

function userTexts(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as {
      messages?: readonly { role?: string; content?: unknown }[];
    };
    return (parsed.messages ?? [])
      .filter((message) => message.role === "user")
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content),
      );
  } catch {
    return [];
  }
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

function textChunks(text: string): readonly unknown[] {
  const base = {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: 1,
    model: "mock-model",
  };
  return [
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    },
  ];
}
