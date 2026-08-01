import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  SESSION_EFFORTS,
  type EpochMillis,
  type InjectedInput,
  type InjectionReceipt,
  type RequestOutcome,
  type RuntimeCapabilities,
  type RuntimeObservation,
  type RuntimeRequestId,
  type RuntimeSessionHandle,
  type RuntimeSessionRef,
  type RuntimeStartConfig,
  type SessionRuntimeAdapter,
  type TranscriptPoint,
  type WriteIntent,
  type WriteIntentDeclaration,
} from "@plotroom/core";

/**
 * The scripted runtime: a declared script of observations, replayed exactly.
 *
 * It exists because the run spine must be testable without a model. Everything
 * downstream of the seam — the observation log, the phase reducer, accounting,
 * the WS stream, the completion loop — is the code path a real runtime drives,
 * so a scripted session is not a simulation of the product but the product with
 * a deterministic runtime plugged in (decision 0001's whole point).
 *
 * It is registered only when the operator selects it (`PLOTROOM_RUNTIME`), so a
 * default install cannot run a client-supplied script.
 *
 * ## Script format
 *
 * ```jsonc
 * {
 *   "acts": [
 *     {
 *       "on": "start",                                   // "start" | "injection"
 *       "steps": [
 *         { "observation": { "kind": "turn-started", "turn": 1 } },
 *         // Pacing: the stream really pauses here, so a client that opens the
 *         // panel mid-turn sees a live turn rather than a finished one.
 *         { "delay": { "ms": 250 } },
 *         { "observation": { "kind": "output-delta", "text": "working on it" } },
 *         // A declared side effect: what a real agent's tool call would leave
 *         // behind, so a world condition has something true to observe.
 *         { "effect": { "kind": "write-file", "path": "out.txt", "content": "done" } },
 *         // A structured question (§6.4): raised, and the act stops until the
 *         // operator answers. No timer resolves it, ever.
 *         { "ask": { "text": "ship it?", "options": ["yes", "no"] } },
 *         // Stands in for the submission tool Epic 4.5 gives a real session.
 *         // It ends the act: the session is waiting for PlotRoom's answer.
 *         { "submit": {} },
 *         { "observation": { "kind": "turn-ended", "turn": 1,
 *                            "usage": { "inputTokens": 10, "outputTokens": 5 } } }
 *       ]
 *     },
 *     { "on": "injection", "steps": [] }   // played when PlotRoom injects
 *   ]
 * }
 * ```
 *
 * Rules the format keeps:
 *
 * - Observations are replayed verbatim; only `at` is supplied, from the injected
 *   clock, because an adapter stamps observations and PlotRoom derives elapsed.
 * - A `submit` step ends its act. Completion is proven by PlotRoom, so the
 *   script cannot script its own success — the next act plays when the feedback
 *   arrives, exactly as a real session continues within its budget (§3.5).
 * - `session-ended` closes the stream. A script that omits it leaves the session
 *   in flight, which is how interruption-on-restart is exercised (principle 11).
 * - `delay` pauses the act for real wall-clock milliseconds, capped at
 *   {@link SCRIPTED_MAX_DELAY_MS} and refused above it. Only this runtime has
 *   one: pacing is a property of the double, not of PlotRoom, and nothing
 *   downstream of the seam knows a delay happened — it observes the same stream,
 *   more slowly.
 *
 * ## Accruing cost, for budget enforcement (§8)
 *
 * A script spends money by **reporting usage on a turn**, exactly as a real
 * runtime does — there is no separate "spend" step, because inventing one would
 * mean the scripted path accrued cost by a route no real adapter takes:
 *
 * ```jsonc
 * { "observation": { "kind": "turn-started", "turn": 1 } },
 * { "observation": { "kind": "turn-ended", "turn": 1,
 *                    "usage": { "inputTokens": 100, "outputTokens": 50,
 *                               "costUsd": 4 } } },
 * // A pause, so PlotRoom's enforcement lands between turns rather than after the
 * // whole script has already been buffered.
 * { "delay": { "ms": 50 } },
 * { "observation": { "kind": "turn-started", "turn": 2 } },
 * // ... which is the turn a budget stop cuts off.
 * ```
 *
 * `costUsd` is what the runtime reports, so the accounting basis is
 * `runtime-reported` and the attribution row says `reported`. Omit it and PlotRoom
 * prices from tokens only if a pricing table is configured; a script that reports
 * neither is a session that contributes no evidence about money, which is the
 * honest default (§4.1).
 *
 * `session-ended` with `out-of-budget` remains **not expressible** — PlotRoom
 * initiates budget stops, so a script that could declare one would let the rule be
 * broken in a fixture (§3.6, §8).
 */
export const SCRIPTED_ADAPTER_ID = "scripted";

/**
 * The tool a session calls to submit its outcome. The scripted runtime emits it
 * for a `submit` step; Epic 4.5's agent tool surface will expose the same name
 * to a real runtime, so the driver watches for one thing, not two.
 */
export const PLOTROOM_SUBMIT_TOOL = "plotroom_submit_outcome";

/**
 * The tool name a declared `write-file` effect is gated as (§3.4).
 *
 * A scripted write is not a shortcut past the claim gate: it raises the same
 * `tool-permission` request a real runtime's write raises, waits for PlotRoom's
 * answer, and does not touch the disk when the answer is no. That is what makes
 * the scripted runtime provable evidence about claim enforcement rather than a
 * path that happens not to be enforced.
 */
export const SCRIPTED_WRITE_TOOL = "scripted_write_file";

/**
 * What the scripted runtime's one tool writes, declared like every other
 * adapter's (`WriteIntentDeclaration`). Exactly the path the step named — so a
 * scripted write is claim-checked rather than approval-raising, which is the
 * case Epic 5.5 needs to be able to test at all.
 */
export function scriptedWriteIntents(): WriteIntentDeclaration {
  return {
    adapterId: SCRIPTED_ADAPTER_ID,
    intentOf(toolName: string, input: unknown): WriteIntent {
      if (toolName !== SCRIPTED_WRITE_TOOL) {
        return {
          kind: "unbounded",
          reason: `${toolName} has no declared write extent for the scripted runtime`,
        };
      }
      const path = (input as { readonly path?: unknown } | null)?.path;
      if (typeof path !== "string" || path.length === 0) {
        return {
          kind: "unbounded",
          reason: "a write step named no path, so its extent is unknown",
        };
      }
      return { kind: "paths", paths: [path] };
    },
  };
}

export const SCRIPTED_CAPABILITIES: RuntimeCapabilities = {
  // Nothing native: a fork is PlotRoom seeding a new scripted session.
  fork: "none",
  injection: "between-turns",
  // A script declares usage; whether it names a cost is the script's business.
  reportsCost: true,
  reportsContextWindow: false,
  // The script cannot run a tool PlotRoom did not allow — there is no tool
  // layer to escape from — so the C6 gate is satisfied by construction.
  enforcesPermissions: true,
};

/* ----------------------------------------------------------- the script shape */

const usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  contextWindow: z
    .object({
      usedTokens: z.number().int().nonnegative(),
      maxTokens: z.number().int().positive(),
    })
    .optional(),
});

const endReason = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("completed") }),
  z.object({ kind: z.literal("ended-by-user") }),
  z.object({ kind: z.literal("stopped"), by: z.enum(["user", "session"]) }),
  z.object({ kind: z.literal("failed"), message: z.string() }),
  z.object({ kind: z.literal("interrupted"), message: z.string() }),
]);

/**
 * The observation vocabulary, minus `at`. `out-of-budget` is deliberately not
 * expressible: PlotRoom initiates budget stops, so no adapter may report one
 * (§3.6, §8) — and a test double that could would let the rule be broken in a
 * fixture.
 */
const scriptedObservation = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("turn-started"),
    turn: z.number().int().positive(),
  }),
  z.object({ kind: z.literal("reasoning-delta"), text: z.string() }),
  z.object({ kind: z.literal("output-delta"), text: z.string() }),
  z.object({
    kind: z.literal("tool-started"),
    toolName: z.string().min(1),
    callId: z.string().min(1),
    input: z.unknown(),
  }),
  z.object({
    kind: z.literal("tool-finished"),
    callId: z.string().min(1),
    output: z.unknown(),
    isError: z.boolean().default(false),
  }),
  z.object({ kind: z.literal("compaction-started") }),
  z.object({ kind: z.literal("compaction-finished") }),
  z.object({
    kind: z.literal("request-raised"),
    requestId: z.string().min(1),
    request: z.union([
      z.object({
        kind: z.literal("tool-permission"),
        toolName: z.string().min(1),
        input: z.unknown(),
      }),
      z.object({
        kind: z.literal("question"),
        text: z.string(),
        options: z.array(z.string()),
      }),
    ]),
  }),
  z.object({
    kind: z.literal("turn-ended"),
    turn: z.number().int().positive(),
    usage,
  }),
  z.object({ kind: z.literal("session-ended"), reason: endReason }),
  z.object({
    kind: z.literal("runtime-error"),
    message: z.string(),
    fatal: z.boolean().default(false),
  }),
]);

const effect = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("write-file"),
    /** Relative to the workspace root; an absolute path is refused. */
    path: z.string().min(1),
    content: z.string(),
  }),
]);

export type ScriptedEffect = z.infer<typeof effect>;

/**
 * A declared structured question (§6.4).
 *
 * The scripted equivalent of pi's `plotroom_ask`: it raises the same
 * `request-raised` observation with `kind: "question"`, so the question reaches
 * the same store, the same event, and the same operator answer path a real
 * runtime's does. The act **ends here** — the session is blocked on the answer,
 * which is what a question is, and no timer resolves it (principle 2). The answer
 * arrives as `respond`, which resolves the pending request and plays on.
 */
const question = z.object({
  text: z.string().min(1),
  options: z.array(z.string().min(1)).min(1),
});

export type ScriptedQuestion = z.infer<typeof question>;

/**
 * A declared tool call that is **not** a workspace write (§6.6).
 *
 * The `effect` step above raises a permission request for a write whose extent
 * the adapter declares, which claims answer (§3.4). This raises one for a tool
 * nothing declares — a shell, an integration write — so its extent is unbounded
 * and the gate cannot answer it from claims: it asks (`undeclared-write-extent`),
 * and the call stays blocked until the operator answers the approval.
 *
 * It exists because the blocked-call loop is otherwise unprovable without a
 * model: the whole point of the scripted runtime is that the spine can be proved
 * without one, and "the call really did stay open until a human answered" is a
 * property of that spine. The act does not end here — the answer arrives as
 * `respond` and the script plays on, which is what makes "the call unblocked"
 * observable rather than inferred.
 */
const gatedCall = z.object({
  /** Any name the adapter does not declare, which is what makes it unbounded. */
  toolName: z.string().min(1),
  input: z.unknown().optional(),
});

export type ScriptedGatedCall = z.infer<typeof gatedCall>;

const submission = z.object({
  /** What the session says it produced; PlotRoom checks the conditions itself. */
  outputs: z
    .array(
      z.object({
        name: z.string().min(1),
        objectId: z.string().min(1),
        versionId: z.string().min(1),
      }),
    )
    .optional(),
  note: z.string().optional(),
});

/**
 * Pacing. A real model takes seconds between turns, and a script that replays a
 * whole session inside one tick makes a streaming assertion pass for the wrong
 * reason: the client refetched and found it already finished. A delay is
 * therefore a declared step rather than something the adapter invents, so a test
 * asks for exactly the pause it needs.
 *
 * Bounded, and refused rather than clamped past the bound: a script that asked
 * for a minute would be a hung test with a plausible explanation, which is worse
 * than a script that fails to parse.
 */
export const SCRIPTED_MAX_DELAY_MS = 5_000;

const delay = z.object({
  ms: z
    .number()
    .int()
    .positive()
    .max(SCRIPTED_MAX_DELAY_MS, {
      message: `a scripted delay is capped at ${SCRIPTED_MAX_DELAY_MS}ms; a longer pause is a hung test, not a slow model`,
    }),
});

const step = z
  .object({
    observation: scriptedObservation.optional(),
    effect: effect.optional(),
    submit: submission.optional(),
    ask: question.optional(),
    call: gatedCall.optional(),
    delay: delay.optional(),
  })
  .refine(
    (value) =>
      [
        value.observation,
        value.effect,
        value.submit,
        value.ask,
        value.call,
        value.delay,
      ].filter((one) => one !== undefined).length === 1,
    {
      message:
        "a step is exactly one of observation, effect, submit, ask, call, or delay",
    },
  );

const act = z.object({
  on: z.enum(["start", "injection"]).default("start"),
  steps: z.array(step),
});

export const runtimeScriptSchema = z.object({
  /** Optional, for readability in fixtures; never used as identity. */
  name: z.string().optional(),
  acts: z.array(act).min(1),
  /** Overridden per launch by the session's own choices; here for fixtures. */
  effort: z.enum(SESSION_EFFORTS).optional(),
});

export type RuntimeScript = z.infer<typeof runtimeScriptSchema>;
export type ScriptedSubmission = z.infer<typeof submission>;

/** What a `submit` step carries, once the driver recognises the tool call. */
export function parseSubmission(input: unknown): ScriptedSubmission {
  const parsed = submission.safeParse(input);
  return parsed.success ? parsed.data : {};
}

/* ---------------------------------------------------------------- the adapter */

export interface ScriptedRuntimeAdapter extends SessionRuntimeAdapter {
  /**
   * Start a session that replays exactly this script. Separate from `start` so
   * the seam stays honest: `SessionRuntimeAdapter` has no notion of a script,
   * and nothing but the server's own launch path can supply one.
   */
  startWithScript(
    script: RuntimeScript,
    config: RuntimeStartConfig,
  ): Promise<RuntimeSessionHandle>;
}

export function isScriptedRuntime(
  adapter: SessionRuntimeAdapter,
): adapter is ScriptedRuntimeAdapter {
  return (
    adapter.id === SCRIPTED_ADAPTER_ID &&
    typeof (adapter as ScriptedRuntimeAdapter).startWithScript === "function"
  );
}

export interface ScriptedRuntimeOptions {
  readonly now: () => EpochMillis;
  /** Used when a launch supplies no script of its own. */
  readonly defaultScript?: RuntimeScript;
}

export function createScriptedRuntime(
  options: ScriptedRuntimeOptions,
): ScriptedRuntimeAdapter {
  let started = 0;

  const open = (
    script: RuntimeScript,
    config: RuntimeStartConfig,
  ): RuntimeSessionHandle => {
    started += 1;
    return new ScriptedSessionHandle(
      `scripted-${started}`,
      script,
      config,
      options.now,
    );
  };

  const requireScript = (script?: RuntimeScript): RuntimeScript => {
    const resolved = script ?? options.defaultScript;
    if (resolved === undefined) {
      throw new Error(
        "the scripted runtime was selected but no script was supplied (per launch or PLOTROOM_RUNTIME_SCRIPT)",
      );
    }
    return resolved;
  };

  return {
    id: SCRIPTED_ADAPTER_ID,
    capabilities: SCRIPTED_CAPABILITIES,

    async start(config) {
      return open(requireScript(), config);
    },

    async startWithScript(script, config) {
      return open(script, config);
    },

    async resume(_ref: RuntimeSessionRef, config) {
      // A scripted session has no native state to resume; replaying the script
      // is the honest equivalent, and it is labelled as a fresh replay rather
      // than pretending to continue one.
      return open(requireScript(), {
        prompt: "",
        launch: config.launch,
        workspacePath: config.workspacePath,
      });
    },

    async fork(_ref: RuntimeSessionRef, _point: TranscriptPoint, config) {
      return open(requireScript(), config);
    },
  };
}

class ScriptedSessionHandle implements RuntimeSessionHandle {
  readonly ref: RuntimeSessionRef;

  readonly #script: RuntimeScript;
  readonly #config: RuntimeStartConfig;
  readonly #now: () => EpochMillis;
  readonly #queue = new ObservationQueue();

  #actIndex = 0;
  #stopped = false;
  /**
   * Requests waiting for PlotRoom's answer. A stop settles them as denials
   * rather than leaving the act hanging: a session that has ended writes nothing,
   * and a promise nobody will resolve is a hung process, not a refusal.
   */
  readonly #pending = new Map<RuntimeRequestId, (o: RequestOutcome) => void>();
  /**
   * Acts play one at a time, in order. A delayed act would otherwise interleave
   * with the act an injection triggers, and a script's meaning would depend on
   * how long its pauses were.
   */
  #playing: Promise<void> = Promise.resolve();

  constructor(
    ref: RuntimeSessionRef,
    script: RuntimeScript,
    config: RuntimeStartConfig,
    now: () => EpochMillis,
  ) {
    this.ref = ref;
    this.#script = script;
    this.#config = config;
    this.#now = now;
    this.#playing = this.#play("start");
  }

  observations(): AsyncIterable<RuntimeObservation> {
    return this.#queue;
  }

  async inject(input: InjectedInput): Promise<InjectionReceipt> {
    const queuedAt = this.#now();
    if (this.#stopped) {
      throw new Error(
        "the scripted session has ended; it accepts no injection",
      );
    }

    // Queue acceptance is what this resolving proves; delivery is the separate
    // observed fact (§6.5), so it is pushed as its own observation.
    this.#queue.push({
      kind: "injection-delivered",
      injectionId: input.id,
      at: this.#now(),
    });
    this.#playing = this.#playing.then(() => this.#play("injection"));

    return { id: input.id, queuedAt };
  }

  async respond(
    requestId: RuntimeRequestId,
    outcome: RequestOutcome,
  ): Promise<void> {
    this.#queue.push({
      kind: "request-settled",
      requestId,
      outcome,
      at: this.#now(),
    });

    const settle = this.#pending.get(requestId);
    if (settle === undefined) return;
    this.#pending.delete(requestId);
    settle(outcome);
  }

  async stop(_mode: "graceful" | "abort"): Promise<void> {
    if (this.#stopped) return;
    this.#end({ kind: "stopped", by: "user" });
  }

  /**
   * Play the next act declared for this trigger. A `submit` step ends the act:
   * the session is waiting for PlotRoom's answer, which is the only way a
   * producing session's outcome can be proven rather than claimed (§3.5).
   *
   * Async because a `delay` step really waits. Everything downstream of the seam
   * is unaffected: it reads the same observations off the same queue, just spread
   * over real time — which is the point of asking for a pause at all.
   */
  async #play(trigger: "start" | "injection"): Promise<void> {
    if (this.#stopped) return;

    while (this.#actIndex < this.#script.acts.length) {
      const act = this.#script.acts[this.#actIndex];
      if (act === undefined) return;
      if (act.on !== trigger) return;
      this.#actIndex += 1;

      for (const step of act.steps) {
        if (step.delay !== undefined) {
          await sleep(step.delay.ms);
          // Stopping during a pause abandons the rest of the act: the session is
          // over, and replaying what it was going to say next would be a record
          // of something that never happened.
          if (this.#stopped) return;
          continue;
        }

        if (step.ask !== undefined) {
          // The question is raised and the act stops: a session that asked is
          // waiting, and playing on would be the script answering its own
          // question. The operator's answer arrives as `respond`, which resolves
          // this and lets the next act run.
          const answer = await this.#requestQuestion(step.ask);
          if (this.#stopped) return;
          this.#queue.push({
            kind: "output-delta",
            text:
              answer.kind === "answer"
                ? `the operator chose: ${answer.value}`
                : "nobody answered",
            at: this.#now(),
          });
          continue;
        }

        if (step.call !== undefined) {
          // A tool nothing declared: unbounded, therefore approval-raising
          // (§6.6). The session waits for the answer and then says what it was
          // told, so both halves of the loop are observable in the log — the
          // allow it proceeded on, or the operator's own reason for the denial.
          const outcome = await this.#requestTool(step.call);
          if (this.#stopped) return;
          this.#queue.push({
            kind: "output-delta",
            text:
              outcome.kind === "allow"
                ? `${step.call.toolName} was approved`
                : `${step.call.toolName} was declined: ${
                    outcome.kind === "deny" ? outcome.reason : outcome.value
                  }`,
            at: this.#now(),
          });
          continue;
        }

        if (step.effect !== undefined) {
          // Gated, not assumed. The write raises a `tool-permission` request and
          // waits for PlotRoom's answer; a denial leaves the disk untouched and
          // the refusal in the observation log, which is what §3.4 enforcement
          // looks like from the runtime's side.
          const outcome = await this.#requestPermission(step.effect);
          if (this.#stopped) return;
          if (outcome.kind !== "allow") continue;
          this.#applyEffect(step.effect);
          continue;
        }

        if (step.submit !== undefined) {
          const callId = `submit-${this.#actIndex}`;
          this.#queue.push({
            kind: "tool-started",
            toolName: PLOTROOM_SUBMIT_TOOL,
            callId,
            input: step.submit,
            at: this.#now(),
          });
          this.#queue.push({
            kind: "tool-finished",
            callId,
            output: "submitted",
            isError: false,
            at: this.#now(),
          });
          return;
        }

        if (step.observation === undefined) continue;

        if (step.observation.kind === "session-ended") {
          this.#end(step.observation.reason);
          return;
        }

        this.#queue.push({
          ...step.observation,
          at: this.#now(),
        } as RuntimeObservation);
      }

      return;
    }
  }

  /**
   * Raise the permission request a declared write needs answered, and wait.
   *
   * The wait is unbounded on purpose: PlotRoom answers every request it observes,
   * and a timeout here would be the runtime deciding it may write because nobody
   * replied fast enough — exactly the fail-open the C6 gate exists to prevent.
   * A stop settles it as a denial, so nothing hangs forever.
   */
  #requestPermission(declared: ScriptedEffect): Promise<RequestOutcome> {
    const requestId =
      `req-${this.#pending.size + 1}-${this.#actIndex}` as RuntimeRequestId;

    return new Promise<RequestOutcome>((resolve) => {
      this.#pending.set(requestId, resolve);
      this.#queue.push({
        kind: "request-raised",
        requestId,
        request: {
          kind: "tool-permission",
          toolName: SCRIPTED_WRITE_TOOL,
          input: { path: declared.path },
        },
        at: this.#now(),
      });
    });
  }

  /**
   * Raise the permission request a declared, undeclared-extent tool call needs
   * answered, and wait. Unbounded like the write gate's wait, and for the same
   * reason: a timeout here would be the runtime deciding it may proceed because
   * nobody replied fast enough (§6.6, principle 2).
   */
  #requestTool(declared: ScriptedGatedCall): Promise<RequestOutcome> {
    const requestId =
      `call-${this.#pending.size + 1}-${this.#actIndex}` as RuntimeRequestId;

    return new Promise<RequestOutcome>((resolve) => {
      this.#pending.set(requestId, resolve);
      this.#queue.push({
        kind: "request-raised",
        requestId,
        request: {
          kind: "tool-permission",
          toolName: declared.toolName,
          input: declared.input ?? {},
        },
        at: this.#now(),
      });
    });
  }

  /**
   * Raise a structured question and wait for PlotRoom's answer.
   *
   * Unbounded, like the write gate's wait and for the same reason: §6.4 forbids a
   * timed default, so a timeout here would be the runtime answering its own
   * question when nobody replied fast enough. A stop settles it as a denial, so
   * nothing hangs past the session's own end.
   */
  #requestQuestion(declared: ScriptedQuestion): Promise<RequestOutcome> {
    const requestId =
      `ask-${this.#pending.size + 1}-${this.#actIndex}` as RuntimeRequestId;

    return new Promise<RequestOutcome>((resolve) => {
      this.#pending.set(requestId, resolve);
      this.#queue.push({
        kind: "request-raised",
        requestId,
        request: {
          kind: "question",
          text: declared.text,
          options: declared.options,
        },
        at: this.#now(),
      });
    });
  }

  #applyEffect(declared: ScriptedEffect): void {
    if (isAbsolute(declared.path)) {
      throw new Error(
        `a scripted effect writes inside the workspace; "${declared.path}" is absolute`,
      );
    }

    const target = resolve(join(this.#config.workspacePath, declared.path));
    const root = resolve(this.#config.workspacePath);
    if (!target.startsWith(`${root}/`) && target !== root) {
      throw new Error(
        `a scripted effect writes inside the workspace; "${declared.path}" escapes it`,
      );
    }

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, declared.content, "utf8");
  }

  #end(reason: ScriptedEndReason): void {
    this.#stopped = true;
    // Nothing may write after the session ended, and nothing may hang waiting
    // for an answer that will never come.
    for (const [requestId, settle] of this.#pending) {
      this.#pending.delete(requestId);
      settle({
        kind: "deny",
        reason: "the session ended before it was answered",
      });
    }
    this.#queue.push({ kind: "session-ended", reason, at: this.#now() });
    this.#queue.end();
  }
}

type ScriptedEndReason = z.infer<typeof endReason>;

/**
 * A real pause, and the only clock this file keeps. Unref'd so a script's pacing
 * can never be the reason a process refuses to exit.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/** A minimal push queue, so observations stream without a dependency. */
class ObservationQueue implements AsyncIterable<RuntimeObservation> {
  #buffer: RuntimeObservation[] = [];
  #waiting: ((value: IteratorResult<RuntimeObservation>) => void) | null = null;
  #done = false;

  push(observation: RuntimeObservation): void {
    if (this.#done) return;
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = null;
      waiting({ value: observation, done: false });
      return;
    }
    this.#buffer.push(observation);
  }

  end(): void {
    this.#done = true;
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = null;
      waiting({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeObservation> {
    return {
      next: (): Promise<IteratorResult<RuntimeObservation>> => {
        const next = this.#buffer.shift();
        if (next) return Promise.resolve({ value: next, done: false });
        if (this.#done) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.#waiting = resolve;
        });
      },
    };
  }
}
