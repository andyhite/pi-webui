import { asPathKey, type PathKey } from "./ids.js";

/**
 * Claim paths and the hierarchy conflict rule (§3.4).
 *
 * "A claim conflicts with any claim on an ancestor or descendant of its path —
 * `src/` and `src/auth.ts` conflict. Claims cover paths that do not exist yet,
 * and a directory claim covers everything created under them."
 *
 * Nothing here touches a filesystem, which is what makes not-yet-existing paths
 * ordinary: a claim is a statement about a *name*, not about a file. There is no
 * `stat`, so there is nothing to be missing.
 *
 * **Canonicalization, stated** — the rules are choices, and every one of them
 * errs toward folding two spellings together rather than apart, because two
 * spellings treated as different paths hand two writers the same file:
 *
 * - **Relative only.** A claim path is workspace-relative. An absolute path or a
 *   drive prefix is refused rather than silently re-anchored: accepting
 *   `/etc/passwd` as `etc/passwd` would answer a question nobody asked.
 * - **Separators.** `\` is normalized to `/`. A POSIX file may legally contain a
 *   backslash; such a file cannot be claimed under that spelling, and the
 *   trade is deliberate — folding `src\auth.ts` into `src/auth.ts` can only ever
 *   make the conflict check *more* conservative.
 * - **Trailing and repeated separators are insignificant.** `src/`, `src`, and
 *   `src//` are one path. A directory claim covers its subtree either way, so
 *   the distinction carries no meaning to preserve.
 * - **`.` and `..` are resolved, and an escape is refused.** `src/../lib` is
 *   `lib`; `../outside` is refused with `escapes_root`. A claim that reached
 *   outside the workspace would breach the boundary the workspace *is*.
 * - **Comparison is case-insensitive; the authored case is preserved for
 *   display.** On a case-insensitive filesystem `README.md` and `readme.md` are
 *   one file, and handing them to two holders as two paths would break the one
 *   guarantee claims exist to make (principle 4). Folding costs a case-sensitive
 *   filesystem the ability to claim two spellings separately, which nobody
 *   wants; not folding costs correctness on macOS and Windows.
 * - **Surrounding whitespace is trimmed**, as a typo rather than a name.
 */

export interface ClaimPath {
  /** The canonical form in the case it was authored in — what messages show. */
  readonly display: string;
  /** Case-folded comparison key. The workspace root's key is the empty string. */
  readonly key: PathKey;
  /** Case-folded segments, so hierarchy is a prefix test rather than a substring one. */
  readonly segments: readonly string[];
}

export const ROOT_PATH: ClaimPath = {
  display: ".",
  key: asPathKey(""),
  segments: [],
};

export const PATH_REFUSAL_REASONS = [
  /** Nothing was supplied; the workspace root is spelled `.`, never "". */
  "empty",
  /** Absolute, or drive-prefixed: a claim path is workspace-relative. */
  "absolute",
  /** `..` climbed past the workspace root. */
  "escapes_root",
  /** A segment cannot be part of a path — currently only a NUL byte. */
  "invalid_segment",
] as const;

export type PathRefusalReason = (typeof PATH_REFUSAL_REASONS)[number];

export interface PathRefusal {
  readonly reason: PathRefusalReason;
  readonly message: string;
  /** Echoed back so a refusal names what it refused, never "invalid input". */
  readonly input: string;
}

export type PathCanonicalization =
  | { readonly ok: true; readonly path: ClaimPath }
  | { readonly ok: false; readonly refusal: PathRefusal };

const DRIVE_PREFIX = /^[A-Za-z]:/;

export function canonicalizePath(input: string): PathCanonicalization {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return refuse(
      "empty",
      "a claim path is required; the workspace root is `.`",
      input,
    );
  }

  const slashed = trimmed.replace(/\\/g, "/");

  if (slashed.startsWith("/") || DRIVE_PREFIX.test(slashed)) {
    return refuse(
      "absolute",
      "a claim path is workspace-relative; drop the leading root or drive",
      input,
    );
  }

  const display: string[] = [];
  for (const raw of slashed.split("/")) {
    if (raw.length === 0 || raw === ".") continue;
    if (raw.includes("\0")) {
      return refuse(
        "invalid_segment",
        "a claim path cannot contain a NUL byte",
        input,
      );
    }
    if (raw === "..") {
      if (display.length === 0) {
        return refuse(
          "escapes_root",
          "a claim path cannot climb above the workspace root",
          input,
        );
      }
      display.pop();
      continue;
    }
    display.push(raw);
  }

  if (display.length === 0) return { ok: true, path: ROOT_PATH };

  const segments = display.map(fold);
  return {
    ok: true,
    path: {
      display: display.join("/"),
      key: asPathKey(segments.join("/")),
      segments,
    },
  };
}

/**
 * The same rules, for a caller that has already decided a bad path is a bug
 * rather than input — tests and constants. Throws rather than returning a
 * refusal, so it can never become a quiet fallback in a code path.
 */
export function claimPath(input: string): ClaimPath {
  const result = canonicalizePath(input);
  if (!result.ok) throw new Error(`${result.refusal.message}: ${input}`);
  return result.path;
}

function fold(segment: string): string {
  return segment.toLowerCase();
}

function refuse(
  reason: PathRefusalReason,
  message: string,
  input: string,
): PathCanonicalization {
  return { ok: false, refusal: { reason, message, input } };
}

export function isRootPath(path: ClaimPath): boolean {
  return path.segments.length === 0;
}

export function samePath(a: ClaimPath, b: ClaimPath): boolean {
  return a.key === b.key;
}

/**
 * Is `inner` at or below `outer`? The root contains everything, and a directory
 * claim covers everything created under it — including names that do not exist
 * yet, since this is a comparison of names and not of files.
 */
export function isWithin(inner: ClaimPath, outer: ClaimPath): boolean {
  if (outer.segments.length > inner.segments.length) return false;
  for (let index = 0; index < outer.segments.length; index += 1) {
    if (outer.segments[index] !== inner.segments[index]) return false;
  }
  return true;
}

/** §3.4's hierarchical conflict, exactly: ancestor, descendant, or the same path. */
export function pathsConflict(a: ClaimPath, b: ClaimPath): boolean {
  return isWithin(a, b) || isWithin(b, a);
}

export function pathDepth(path: ClaimPath): number {
  return path.segments.length;
}

/** The segments of `inner` below `outer`; empty when they are the same path. */
export function relativeSegments(
  inner: ClaimPath,
  outer: ClaimPath,
): readonly string[] {
  if (!isWithin(inner, outer)) return [];
  return inner.segments.slice(outer.segments.length);
}

/** For messages, which the spec requires to be actionable rather than terse. */
export function describePath(path: ClaimPath): string {
  return isRootPath(path) ? "the workspace root" : path.display;
}
