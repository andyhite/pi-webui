import type { WriteIntent, WriteIntentDeclaration } from "../../tools/gate.js";

/**
 * What pi's tools write, as a declaration (§3.4's gate needs an extent per call).
 *
 * The permission gate blocks every tool call until PlotRoom answers
 * (`permission-gate.ts`, verified against pi 0.83.0). To answer with a *claim*
 * rather than an approval, PlotRoom has to know which paths the call would write —
 * and that is knowledge about pi's tool surface, so it is declared here rather
 * than guessed at the call site.
 *
 * The baseline below contains only what has been verified. Everything else is
 * `unbounded`, which raises an approval instead of consulting claims: slow, and
 * never wrong. Adding an entry is how a tool becomes claim-gated, and each entry
 * is a statement that someone checked pi's actual input shape for it.
 *
 * **What a wrong entry costs.** This declaration is the trust boundary and nothing
 * downstream re-derives it — principle 7 cuts both ways: PlotRoom does not guess at
 * what a tool writes, and it also does not second-guess a declaration. A `paths`
 * entry naming the wrong input field makes the gate check a path the call is not
 * writing, and the write then lands outside the claim it was checked against, because
 * claims are only enforceable over *declared* paths. A `none` entry on a tool that
 * does write executes with no check at all. That is why the default is `unbounded`
 * and why every entry here cites the version it was verified against.
 */

export type PiWriteExtent =
  | { readonly kind: "none" }
  /** The named input fields carry workspace paths this tool writes. */
  | { readonly kind: "paths"; readonly pathFields: readonly string[] }
  | { readonly kind: "unbounded"; readonly reason: string };

export interface PiToolWriteExtent {
  readonly toolName: string;
  readonly extent: PiWriteExtent;
}

/**
 * Verified against pi 0.83.0 by the C6 spike, which drove a real `bash` call
 * through the gate and observed the side effect it was allowed (and the absence
 * of one when denied).
 */
export const PI_KNOWN_WRITE_EXTENTS: readonly PiToolWriteExtent[] = [
  {
    toolName: "bash",
    extent: {
      kind: "unbounded",
      reason: "a shell can write any path in the workspace",
    },
  },
];

export function createPiWriteIntents(
  extents: readonly PiToolWriteExtent[] = PI_KNOWN_WRITE_EXTENTS,
): WriteIntentDeclaration {
  const byName = new Map(
    extents.map((entry) => [entry.toolName, entry.extent]),
  );

  return {
    adapterId: "pi",
    intentOf(toolName: string, input: unknown): WriteIntent {
      const extent = byName.get(toolName);
      if (extent === undefined) {
        return {
          kind: "unbounded",
          reason: `${toolName} has no declared write extent for pi`,
        };
      }
      if (extent.kind !== "paths") return extent;

      const paths = readPaths(input, extent.pathFields);
      if (paths === null) {
        return {
          kind: "unbounded",
          reason: `${toolName} declared path fields ${extent.pathFields.join(", ")}, but the call did not supply them`,
        };
      }
      return { kind: "paths", paths };
    },
  };
}

/**
 * Null rather than an empty list when a declared field is missing: "no paths" and
 * "the paths are unknown" are different answers, and only one of them is safe.
 */
function readPaths(
  input: unknown,
  fields: readonly string[],
): readonly string[] | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  const paths: string[] = [];

  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) {
      paths.push(value);
      continue;
    }
    if (
      Array.isArray(value) &&
      value.every((entry) => typeof entry === "string")
    ) {
      paths.push(...(value as string[]));
      continue;
    }
    return null;
  }

  return paths;
}
