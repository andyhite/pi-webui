import { writeSync } from "node:fs";
import {
  FRAME_FD,
  resolveOmpForkTarget,
  type SessionHostEvent,
} from "@plotroom/core";
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

/** Nothing to write: the fd either accepts a zero-length write or it is not one. */
const EMPTY_PROBE = Buffer.alloc(0);

/** Said once, because a channel that is gone stays gone. */
let frameChannelLost = false;

/**
 * Frames go out synchronously in write order. Nothing here awaits the pipe: an
 * observation reordered behind another would be a transcript that happened in a
 * different order than the session did — and a synchronous write to a blocking
 * pipe is also what makes the flush-before-exit dance unnecessary, because a
 * frame is in the pipe by the time this returns rather than in a stream buffer.
 *
 * `write(2)` on a pipe may take fewer bytes than it was given, so the loop is
 * the point: a frame written in part is exactly the corruption this channel
 * exists to prevent.
 *
 * A synchronous write can also **throw** where the buffered stream call it
 * replaced would have emitted `error` on a later tick — `EPIPE`, once the server
 * has closed its end. This is called from inside the vendor's own event
 * dispatch (`host.ts`), and how that code treats a throwing subscriber is not
 * ours to assume, so the failure stops here: noted on stderr, which is all that
 * is left, and then dropped. The session ends the moment stdin closes, which is
 * what a server that stopped reading has already done.
 */
function writeFrame(frame: SessionHostEvent): void {
  const bytes = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
  let written = 0;
  try {
    while (written < bytes.length) {
      written += writeSync(FRAME_FD, bytes, written, bytes.length - written);
    }
  } catch (error) {
    if (frameChannelLost) return;
    frameChannelLost = true;
    process.stderr.write(
      `the session host's frame channel closed under a write, so PlotRoom is no longer observing this session: ${describe(error)}\n`,
    );
  }
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

    if (args.through !== null) {
      // §6.3: `session.fork()` copies the whole active branch (the tip case);
      // `session.branch(entryId)` rewinds to an earlier one. Both mutate this
      // freshly-opened session's own file in place — never the source's, which
      // is what makes this safe to run before `ref` is read below.
      const target = resolveOmpForkTarget(
        session.getUserMessagesForBranching(),
        { turn: args.through },
      );
      if (target.kind === "unavailable") {
        writeFrame({ type: "fatal", message: target.reason });
        return 4;
      }
      const forked =
        target.kind === "tip"
          ? await session.fork()
          : !(await session.branch(target.entryId)).cancelled;
      if (!forked) {
        // `fork()` also answers `false` when the session is not persisting —
        // named alongside the more common cancellation rather than assuming
        // the cause, since either way nothing was forked.
        writeFrame({
          type: "fatal",
          message:
            "the fork did not complete: a hook cancelled it, or the session was not persisting",
        });
        return 4;
      }
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

// The frame channel, before the session: everything this process has to say
// leaves over fd 3, so without it there is nothing to report a failure *with*.
// Said on stderr — the only channel left — and refused, rather than writing
// frames to stdout, where the corruption issue #109 fixed came from.
//
// The probe is a zero-length **write**, not an `fstat`: under Bun fd 3 can be
// something this process inherited and cannot write, so `fstat` answers "yes" and
// the first real frame then dies of `EBADF` in the middle of a session. Asking
// the fd to do the one thing it exists for is the only question worth asking.
try {
  writeSync(FRAME_FD, EMPTY_PROBE);
} catch {
  process.stderr.write(
    `the session host was started without a writable frame channel on fd ${FRAME_FD.toString()}; it is spawned by PlotRoom's server, not run by hand\n`,
  );
  process.exit(5);
}

const code = await main();

// No flush: `writeFrame` writes synchronously, so every frame is already in the
// pipe rather than in a stream buffer waiting for a tick that exiting skips.
process.exit(code);

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
