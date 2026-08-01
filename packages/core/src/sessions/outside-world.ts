import type { EpochMillis, RuntimeObservation } from "./runtime.js";

/**
 * Outside-world markers (§6.3), derived from reversibility declarations (§6.6,
 * §9.2).
 *
 * "The product marks the points where a session touched the outside world,
 * because a fork before such a point is clean and a fork after it is not."
 *
 * §6.6 names the source of truth and rules out the alternative: "every
 * integration write action declares whether it is reversible (§9.2)... The same
 * declarations are what mark where a session touched the outside world (§6.3),
 * so fork-cleanliness comes from the source of truth rather than a heuristic."
 * So nothing here guesses from a tool's name or its arguments. A tool is declared
 * local, declared as an outside-world write, or **undeclared** — and undeclared
 * costs certainty rather than being read as harmless (principle 7).
 */

/**
 * What undoing this write would take (§9.2).
 *
 * Three values, not two. `"unknown"` is what a plugin author writes when the
 * action's reversibility genuinely depends on the target system's configuration —
 * and it is **treated as irreversible everywhere** (`isIrreversibleWrite`,
 * principle 7). A two-valued type forced that author to pick, and the picked
 * value would have been `"reversible"`, because that is the one that does not
 * interrupt anybody. Declaring the doubt is the honest option, so the type has to
 * have one.
 */
export type WriteReversibility = "reversible" | "irreversible" | "unknown";

/**
 * The one place the three values collapse to two.
 *
 * `"unknown"` counts as irreversible: an undo nobody can promise is not an undo.
 * Every caller asks this rather than comparing against `"irreversible"`, so a
 * fourth value could never be quietly read as safe — and §6.6's piercing rule is
 * stated once (`isIrreversibleAsk`), not once per call site.
 */
export function isIrreversibleWrite(
  reversibility: WriteReversibility,
): boolean {
  return reversibility !== "reversible";
}

/**
 * What one tool does to the world. Two variants and no default: a declaration
 * that forgot to say is not representable, so the gap shows up as an *absent*
 * declaration, which is a fact the markers report.
 */
export type ToolWorldDeclaration =
  | {
      readonly kind: "local";
      /** Why this is local, kept because someone must have checked. */
      readonly reason: string;
    }
  | {
      readonly kind: "outside-world";
      /** Which external system — "github", "jira", "the git remote". */
      readonly system: string;
      /** The write action, as §9.2 declares it: "merge", "force-push", "comment". */
      readonly action: string;
      readonly reversibility: WriteReversibility;
    };

export interface ToolWorldDeclarations {
  /** Null for a tool nobody declared — deliberately distinguishable from local. */
  forTool(toolName: string): ToolWorldDeclaration | null;
}

export function declareToolWorld(
  entries: Readonly<Record<string, ToolWorldDeclaration>>,
): ToolWorldDeclarations {
  return { forTool: (toolName) => entries[toolName] ?? null };
}

export const NO_TOOL_WORLD_DECLARATIONS: ToolWorldDeclarations = {
  forTool: () => null,
};

/**
 * Nothing observed. Stated as a value so a caller that has no observation log
 * says so, rather than omitting an argument and being handed the same answer by
 * accident — `planSessionFork` requires markers for exactly that reason.
 */
export const NO_OUTSIDE_WORLD_MARKERS: OutsideWorldMarkers = {
  touches: [],
  undeclared: [],
  turns: [],
};

/** How a declared write call ended, as far as the observation log knows. */
export type TouchOutcome = "succeeded" | "failed" | "unfinished";

export interface OutsideWorldTouch {
  /** The turn it happened in — the grain a fork point is named at (§6.3). */
  readonly turn: number;
  readonly callId: string;
  readonly toolName: string;
  readonly system: string;
  readonly action: string;
  readonly reversibility: WriteReversibility;
  readonly outcome: TouchOutcome;
  readonly at: EpochMillis;
}

/**
 * A tool call whose effect on the world nobody declared. Counted, not ignored:
 * `certain` on a fork's cleanliness is what these take away.
 */
export interface UndeclaredCall {
  readonly turn: number;
  readonly callId: string;
  readonly toolName: string;
  readonly at: EpochMillis;
}

export interface OutsideWorldMarkers {
  readonly touches: readonly OutsideWorldTouch[];
  readonly undeclared: readonly UndeclaredCall[];
  /** Every turn observed, so a fork point can be named even in a clean session. */
  readonly turns: readonly number[];
}

/**
 * Derive the markers from the observation log — the record PlotRoom already
 * keeps, so this is recomputable at any time and never a second source of truth.
 *
 * A declared write that *started* is a touch, whatever happened next: a merge
 * that returned an error may still have merged, and "we are not sure" must never
 * render as "clean". The outcome is recorded beside it so the UI can say which.
 */
export function deriveOutsideWorldMarkers(
  observations: readonly RuntimeObservation[],
  declarations: ToolWorldDeclarations,
): OutsideWorldMarkers {
  const touches: OutsideWorldTouch[] = [];
  const undeclared: UndeclaredCall[] = [];
  const turns: number[] = [];
  const openTouches = new Map<string, number>();
  let turn = 0;

  for (const observation of observations) {
    switch (observation.kind) {
      case "turn-started": {
        turn = observation.turn;
        if (!turns.includes(turn)) turns.push(turn);
        break;
      }

      case "tool-started": {
        const declaration = declarations.forTool(observation.toolName);
        if (declaration === null) {
          undeclared.push({
            turn,
            callId: observation.callId,
            toolName: observation.toolName,
            at: observation.at,
          });
          break;
        }
        if (declaration.kind === "local") break;

        openTouches.set(observation.callId, touches.length);
        touches.push({
          turn,
          callId: observation.callId,
          toolName: observation.toolName,
          system: declaration.system,
          action: declaration.action,
          reversibility: declaration.reversibility,
          outcome: "unfinished",
          at: observation.at,
        });
        break;
      }

      case "tool-finished": {
        const index = openTouches.get(observation.callId);
        if (index === undefined) break;
        openTouches.delete(observation.callId);
        const touch = touches[index] as OutsideWorldTouch;
        touches[index] = {
          ...touch,
          outcome: observation.isError ? "failed" : "succeeded",
        };
        break;
      }

      default:
        break;
    }
  }

  return { touches, undeclared, turns };
}

/**
 * Whether a fork at this point is clean — in three values, not two.
 *
 * `clean` as a boolean was a trap: an undeclared tool call means the product does
 * not *know* whether the world was touched, and a boolean forces that into one of
 * the two answers it is not. Anything reading `.clean` alone would then read
 * "nobody declared anything" as "nothing happened", which is principle 7 exactly
 * backwards. So the third value is a value, and a caller must handle it to
 * compile a `switch` over this type.
 */
export const FORK_CLEANLINESS_STATES = [
  /** Nothing at or before this point touched the outside world, and we can tell. */
  "clean",
  /** A declared outside-world write happened at or before this point. */
  "dirty",
  /**
   * No declared write — but a tool call up to here has no declaration at all, so
   * whether the world was touched is unknown. Not clean: unproven (principle 7).
   */
  "unknown",
] as const;

export type ForkCleanlinessState = (typeof FORK_CLEANLINESS_STATES)[number];

/**
 * What a fork at one point inherits, in the terms §6.3 asks for: was the world
 * already touched, and can the product tell.
 */
export interface ForkCleanliness {
  readonly turn: number;
  readonly state: ForkCleanlinessState;
  readonly touches: readonly OutsideWorldTouch[];
  /** The irreversible subset: what a fork after this point can never undo (§6.6). */
  readonly irreversible: readonly OutsideWorldTouch[];
  /**
   * Calls up to this point that nothing declared. Non-empty with `state: "dirty"`
   * too — a dirty point can also be incompletely known, and the count is what the
   * UI needs to say "at least these".
   */
  readonly undeclaredCalls: readonly UndeclaredCall[];
  /** The sentence a fork dialog shows, so two surfaces cannot word it differently. */
  readonly description: string;
}

/** True only for `"clean"`. Named so no caller has to remember which states pass. */
export function isCleanForkPoint(cleanliness: ForkCleanliness): boolean {
  return cleanliness.state === "clean";
}

/**
 * The flags §6.3 is about: **fork-before-clean, fork-after-dirty**. A fork at
 * turn `n` inherits everything up to and including `n` (`transcriptPrefix`), so
 * cleanliness is decided by the touches at or before `n` — not by the ones after,
 * which the fork never inherits.
 */
export function forkCleanlinessAt(
  markers: OutsideWorldMarkers,
  turn: number,
): ForkCleanliness {
  const touches = markers.touches.filter((touch) => touch.turn <= turn);
  const undeclaredCalls = markers.undeclared.filter(
    (call) => call.turn <= turn,
  );
  const irreversible = touches.filter((touch) =>
    isIrreversibleWrite(touch.reversibility),
  );
  const state: ForkCleanlinessState =
    touches.length > 0
      ? "dirty"
      : undeclaredCalls.length > 0
        ? "unknown"
        : "clean";

  return {
    turn,
    state,
    touches,
    irreversible,
    undeclaredCalls,
    description: describe(state, touches, irreversible, undeclaredCalls),
  };
}

function describe(
  state: ForkCleanlinessState,
  touches: readonly OutsideWorldTouch[],
  irreversible: readonly OutsideWorldTouch[],
  undeclaredCalls: readonly UndeclaredCall[],
): string {
  if (state === "clean") {
    return "clean: this session had not touched the outside world yet";
  }
  if (state === "unknown") {
    const tools = [
      ...new Set(undeclaredCalls.map((call) => call.toolName)),
    ].join(", ");
    return `unknown: nothing here declares an outside-world write, but ${undeclaredCalls.length} call${
      undeclaredCalls.length === 1 ? "" : "s"
    } up to this point (${tools}) declare nothing either way`;
  }
  const systems = [...new Set(touches.map((touch) => touch.system))].join(", ");
  const suffix =
    irreversible.length === 0
      ? ""
      : `, ${irreversible.length} of them irreversible (${[
          ...new Set(
            irreversible.map((touch) =>
              touch.reversibility === "unknown"
                ? `${touch.action} (reversibility undeclared)`
                : touch.action,
            ),
          ),
        ].join(", ")})`;
  // "at least" when some calls up to here declared nothing: the count of known
  // writes is a floor, not a total.
  const atLeast = undeclaredCalls.length === 0 ? "" : "at least ";
  return `not clean: ${atLeast}${touches.length} write${
    touches.length === 1 ? "" : "s"
  } to ${systems} happened at or before this point${suffix}`;
}

/** Cleanliness for every observed turn — what the transcript renders markers from. */
export function forkPointMarkers(
  markers: OutsideWorldMarkers,
): readonly ForkCleanliness[] {
  return markers.turns.map((turn) => forkCleanlinessAt(markers, turn));
}
