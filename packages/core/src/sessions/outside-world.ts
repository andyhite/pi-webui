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

export type WriteReversibility = "reversible" | "irreversible";

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
 * What a fork at one point inherits, in the terms §6.3 asks for: was the world
 * already touched, and can the product be sure.
 */
export interface ForkCleanliness {
  readonly turn: number;
  /** No declared outside-world touch at or before this turn. */
  readonly clean: boolean;
  /**
   * True when every tool call up to this point had a declaration. False means
   * "clean as far as the declarations go" — which the UI must say, rather than
   * promising a cleanliness nobody can prove (principle 7, principle 12).
   */
  readonly certain: boolean;
  readonly touches: readonly OutsideWorldTouch[];
  /** The irreversible subset: what a fork after this point can never undo (§6.6). */
  readonly irreversible: readonly OutsideWorldTouch[];
  readonly undeclaredCalls: readonly UndeclaredCall[];
  /** The sentence a fork dialog shows, so two surfaces cannot word it differently. */
  readonly description: string;
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
  const irreversible = touches.filter(
    (touch) => touch.reversibility === "irreversible",
  );
  const clean = touches.length === 0;
  const certain = undeclaredCalls.length === 0;

  return {
    turn,
    clean,
    certain,
    touches,
    irreversible,
    undeclaredCalls,
    description: describe(clean, certain, touches, irreversible),
  };
}

function describe(
  clean: boolean,
  certain: boolean,
  touches: readonly OutsideWorldTouch[],
  irreversible: readonly OutsideWorldTouch[],
): string {
  if (clean) {
    return certain
      ? "clean: this session had not touched the outside world yet"
      : "clean as far as declarations go: some tool calls up to here declare no effect on the outside world";
  }
  const systems = [...new Set(touches.map((touch) => touch.system))].join(", ");
  const suffix =
    irreversible.length === 0
      ? ""
      : `, ${irreversible.length} of them irreversible (${[
          ...new Set(irreversible.map((touch) => touch.action)),
        ].join(", ")})`;
  return `not clean: ${touches.length} write${
    touches.length === 1 ? "" : "s"
  } to ${systems} happened at or before this point${suffix}`;
}

/** Cleanliness for every observed turn — what the transcript renders markers from. */
export function forkPointMarkers(
  markers: OutsideWorldMarkers,
): readonly ForkCleanliness[] {
  return markers.turns.map((turn) => forkCleanlinessAt(markers, turn));
}
