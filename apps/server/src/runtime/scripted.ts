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
 *         { "observation": { "kind": "output-delta", "text": "working on it" } },
 *         // A declared side effect: what a real agent's tool call would leave
 *         // behind, so a world condition has something true to observe.
 *         { "effect": { "kind": "write-file", "path": "out.txt", "content": "done" } },
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
 */
export const SCRIPTED_ADAPTER_ID = "scripted";

/**
 * The tool a session calls to submit its outcome. The scripted runtime emits it
 * for a `submit` step; Epic 4.5's agent tool surface will expose the same name
 * to a real runtime, so the driver watches for one thing, not two.
 */
export const PLOTROOM_SUBMIT_TOOL = "plotroom_submit_outcome";

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

const step = z
  .object({
    observation: scriptedObservation.optional(),
    effect: effect.optional(),
    submit: submission.optional(),
  })
  .refine(
    (value) =>
      [value.observation, value.effect, value.submit].filter(
        (one) => one !== undefined,
      ).length === 1,
    { message: "a step is exactly one of observation, effect, or submit" },
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
    this.#play("start");
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
    this.#play("injection");

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
  }

  async stop(_mode: "graceful" | "abort"): Promise<void> {
    if (this.#stopped) return;
    this.#end({ kind: "stopped", by: "user" });
  }

  /**
   * Play the next act declared for this trigger. A `submit` step ends the act:
   * the session is waiting for PlotRoom's answer, which is the only way a
   * producing session's outcome can be proven rather than claimed (§3.5).
   */
  #play(trigger: "start" | "injection"): void {
    if (this.#stopped) return;

    while (this.#actIndex < this.#script.acts.length) {
      const act = this.#script.acts[this.#actIndex];
      if (act === undefined) return;
      if (act.on !== trigger) return;
      this.#actIndex += 1;

      for (const step of act.steps) {
        if (step.effect !== undefined) {
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
    this.#queue.push({ kind: "session-ended", reason, at: this.#now() });
    this.#queue.end();
  }
}

type ScriptedEndReason = z.infer<typeof endReason>;

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
