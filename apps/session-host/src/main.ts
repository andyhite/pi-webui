import type { SessionHostEvent } from "@plotroom/core";
import {
  AgentRegistry,
  SessionManager,
  createAgentSession,
} from "@oh-my-pi/pi-coding-agent";
import { parseThinkingLevel } from "@oh-my-pi/pi-coding-agent/thinking";
import { parseSessionHostArgs } from "./args.js";
import { runSessionHost } from "./host.js";
import { PINNED_TOOL_NAMES } from "./tools.js";
import { dispatchWorkerSelector } from "./worker-dispatch.js";

/**
 * PlotRoom's session host: one agent session per process (issue #73).
 *
 * The vendor SDK is embedded here and nowhere else. Everything that leaves this
 * process is `@plotroom/core`'s own vocabulary, which is what makes the runtime
 * replaceable without touching a session record (decision 0001).
 *
 * **Credential posture.** The pi adapter spawned a foreign process and PlotRoom
 * injected nothing: authentication was entirely the host's business, like
 * workspace git. Embedding the SDK changes the shape of that, not the stance —
 * `discoverAuthStorage()` reads the operator's own credential store *inside this
 * process*, so the session host holds provider tokens in memory. The server
 * still does not, and PlotRoom still injects nothing of its own. What that costs
 * this file: nothing PlotRoom writes may carry a credential — not a frame, not a
 * log line, not an error — which is why a startup failure is reported as its own
 * sentence rather than by forwarding a stack trace, and why a session with no
 * authenticated model says exactly that. One honest qualification: a vendor
 * error's `message` is forwarded verbatim into a `fatal` frame and into a failed
 * turn's observation, and that text is the SDK's, not ours. Narrowing it to a
 * class and a code would cost the operator the only account of what went wrong,
 * so it is forwarded knowingly rather than by omission.
 */

/**
 * Frames go out synchronously in write order. Nothing here awaits the pipe: an
 * observation reordered behind another would be a transcript that happened in a
 * different order than the session did.
 */
function writeFrame(frame: SessionHostEvent): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

async function* stdinChunks(): AsyncIterable<string> {
  const decoder = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    yield decoder.decode(chunk, { stream: true });
  }
}

async function main(): Promise<number> {
  let args;
  try {
    args = parseSessionHostArgs(process.argv.slice(2));
  } catch (error) {
    writeFrame({ type: "fatal", message: describe(error) });
    return 2;
  }

  const thinkingLevel = parseThinkingLevel(args.effort);
  if (thinkingLevel === undefined) {
    // Unreachable while `SESSION_EFFORTS` and the SDK's selectors agree, which
    // is exactly why it is checked: a vendor release that drops one must fail
    // here, naming the effort, rather than silently run at a different one.
    writeFrame({
      type: "fatal",
      message: `the session runtime does not understand the effort "${args.effort}"`,
    });
    return 2;
  }

  let session;
  try {
    const sessionManager =
      args.resume === null
        ? SessionManager.create(args.cwd, args.sessionDir)
        : await SessionManager.open(args.resume, args.sessionDir, undefined, {
            initialCwd: args.cwd,
          });

    const created = await createAgentSession({
      cwd: args.cwd,
      modelPattern: args.model,
      thinkingLevel,
      toolNames: [...(args.toolNames ?? PINNED_TOOL_NAMES)],
      // NEVER `restrictToolNames: true`. It silently unloads inline extensions —
      // no error, no warning, `loadedExtensions: 0` — which on the gated path
      // (issue #81) means every tool runs ungated. Proven in issue #66. The
      // restriction PlotRoom wants is this explicit tool set plus the four
      // discovery switches below.
      restrictToolNames: false,
      disableExtensionDiscovery: true,
      enableMCP: false,
      enableLsp: false,
      enableIrc: false,
      // Pinned rather than inherited (issue #73's "what we turn off"): skills,
      // rules, prompt templates and slash commands are the operator's ambient
      // configuration, and a session that picked them up would be running
      // instructions PlotRoom never assembled and cannot show (§3.5, §7.4).
      skills: [],
      rules: [],
      promptTemplates: [],
      slashCommands: [],
      // No interactive surface: a question reaches the human through PlotRoom
      // (§6.4), never through the runtime's own prompt, and an auto-approved
      // tool call would make the gate advice (§6.6).
      hasUI: false,
      autoApprove: false,
      // A registry of this process's own, so nothing routes between sessions
      // behind PlotRoom's back.
      agentRegistry: new AgentRegistry(),
      sessionManager,
    });
    session = created.session;
  } catch (error) {
    writeFrame({
      type: "fatal",
      message: `the session host could not start a session: ${describe(error)}`,
    });
    return 3;
  }

  try {
    if (session.model === undefined) {
      writeFrame({
        type: "fatal",
        message: `no authenticated model available for "${args.model}"`,
      });
      return 4;
    }

    const ref = session.sessionFile;
    if (ref === undefined) {
      // The ref is what resume is addressed by (§3.6). A session PlotRoom could
      // never pick up again is not one worth starting.
      writeFrame({
        type: "fatal",
        message: "the session runtime started a session with no session file",
      });
      return 4;
    }

    await runSessionHost({
      session,
      ref,
      writeFrame,
      input: stdinChunks(),
      now: () => Date.now(),
    });
    return 0;
  } finally {
    await session.dispose();
  }
}

// Before anything else, and before the parser: a compiled session host is also
// the runtime's worker host, because the SDK re-execs this executable for the
// subprocesses its tools need (see `worker-dispatch.ts`). A worker writes no
// frames, so it leaves here rather than falling through to the session path.
const workerExit = await dispatchWorkerSelector(process.argv.slice(2));
if (workerExit !== null) process.exit(workerExit);

const code = await main();

// Flush before leaving: a frame still in the stream's buffer is an observation
// PlotRoom never saw, and the last one is usually the one that mattered.
await new Promise<void>((resolve) => {
  process.stdout.write("", () => {
    resolve();
  });
});
process.exit(code);

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
