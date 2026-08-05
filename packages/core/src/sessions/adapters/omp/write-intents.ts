import type { WriteIntent, WriteIntentDeclaration } from "../../tools/gate.js";

/**
 * What the omp session-host's tools write, as a declaration (§3.4's gate needs
 * an extent per call) — the same conservative posture `pi/write-intents.ts`
 * takes, and for the same reason: this is the trust boundary, so an entry is a
 * statement that someone checked the tool's actual input shape, and everything
 * else stays `unbounded` rather than guessed.
 *
 * PINNED_TOOL_NAMES (`apps/session-host/src/tools.ts`) is the same builtin
 * surface the pi adapter's own C6 spike covered, so `bash` carries the same
 * verified entry. `write` is declared here specifically because of one gap the
 * spike never had to answer: the SDK's own `write` tool dispatches an
 * arbitrary-effect `xd://<device>` tool device when its `path` names one — the
 * write's real extent then has nothing to do with the literal path string, so
 * declaring `paths: ["path"]` unconditionally would let a claim bind the text
 * `"xd://ast_edit"` as if it were a workspace path, which is not a path at all.
 */
export const OMP_ASK_TOOL_NAME = "plotroom_ask";

export type OmpWriteExtent =
  | { readonly kind: "none" }
  /** The named input field carries a workspace path this tool writes. */
  | { readonly kind: "path"; readonly field: string }
  | { readonly kind: "unbounded"; readonly reason: string };

export interface OmpToolWriteExtent {
  readonly toolName: string;
  readonly extent: OmpWriteExtent;
}

export const OMP_KNOWN_WRITE_EXTENTS: readonly OmpToolWriteExtent[] = [
  {
    toolName: "bash",
    extent: {
      kind: "unbounded",
      reason: "a shell can write any path in the workspace",
    },
  },
  {
    toolName: "write",
    extent: { kind: "path", field: "path" },
  },
  // Asks a question and writes nothing; undeclared would be unbounded and
  // raise an approval before the model could even ask (issue #81).
  { toolName: OMP_ASK_TOOL_NAME, extent: { kind: "none" } },
];

export function createOmpWriteIntents(
  extents: readonly OmpToolWriteExtent[] = OMP_KNOWN_WRITE_EXTENTS,
): WriteIntentDeclaration {
  const byName = new Map(
    extents.map((entry) => [entry.toolName, entry.extent]),
  );

  return {
    adapterId: "omp-session-host",
    intentOf(toolName: string, input: unknown): WriteIntent {
      const extent = byName.get(toolName);
      if (extent === undefined) {
        return {
          kind: "unbounded",
          reason: `${toolName} has no declared write extent for the omp session host`,
        };
      }
      if (extent.kind !== "path") return extent;

      const path = readPath(input, extent.field);
      if (path === null) {
        return {
          kind: "unbounded",
          reason: `${toolName} declared its path in "${extent.field}", but the call did not supply one`,
        };
      }
      // xd://<device> dispatches a mounted tool device whose write extent is
      // unrelated to the literal string: it is not a workspace path, so a
      // claim over it would bind text nothing writes and check nothing the
      // device might touch. Matched exactly as the SDK's own `parseXdUrl`
      // does (trim, then case-insensitive) — a narrower check here would
      // silently allow the same call the SDK dispatches as a device write,
      // which is the exact fail-open issue #81 exists to rule out.
      if (isXdUrl(path)) {
        return {
          kind: "unbounded",
          reason: `${toolName} targets a tool device (${path}), not a workspace path`,
        };
      }
      return { kind: "paths", paths: [path] };
    },
  };
}

/**
 * Null rather than an empty string when the declared field is missing or not
 * a string: "no path" and "the path is unknown" are different answers, and
 * only one of them is safe to treat as bounded.
 */
function readPath(input: unknown, field: string): string | null {
  if (typeof input !== "object" || input === null) return null;
  const value = (input as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Whether a `write` target is an `xd://` tool-device URL, matched exactly as
 * the SDK's own `internal-urls/xd-protocol.ts#parseXdUrl` does: trimmed, then
 * case-insensitive. A narrower check (bare `startsWith`, as this once was)
 * would miss `" xd://ast_edit"` or `"XD://ast_edit"`, both of which the SDK
 * still dispatches as a device write while this declaration called them a
 * workspace path — a silent allow through a claim that binds text nothing
 * writes (issue #81's own callout, and the gap a review caught).
 */
function isXdUrl(path: string): boolean {
  return path.trim().toLowerCase().startsWith("xd://");
}
