/**
 * Content and card renderers for diffs and commits (§3.2, §10.1).
 *
 * Two obligations, both principle 12's:
 *
 * - **Truncation is reported, never silent.** A patch can be megabytes; agent-ready
 *   content is capped and `truncated` says how many bytes were dropped and why, so
 *   the surface can show that fact instead of hiding it.
 * - **A delta is what's new, not new state** (§3.2). For a diff, that is which files
 *   entered, left, or changed between two versions of the diff; for a commit, whose
 *   content is immutable, the honest delta is that the object was replaced at all.
 */
import type {
  CardDetail,
  CardRenderer,
  CardView,
  ContentRenderer,
  ProducedObject,
  RenderedContent,
} from "@plotroom/plugin-sdk";

export const CONTENT_RENDERER_ID = "git-content";
export const CARD_RENDERER_ID = "git-card";

/**
 * The cap on agent-ready content, in bytes. Generous enough that an ordinary
 * workspace diff arrives whole, small enough that a vendored lockfile cannot spend a
 * session's entire context — and it is never applied quietly.
 */
export const AGENT_CONTENT_MAX_BYTES = 96 * 1024;

export function cap(content: string, why: string): RenderedContent {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes <= AGENT_CONTENT_MAX_BYTES) {
    return { content, truncated: null };
  }
  const kept = Buffer.from(content, "utf8")
    .subarray(0, AGENT_CONTENT_MAX_BYTES)
    .toString("utf8");
  return {
    content: kept,
    truncated: { omittedBytes: bytes - Buffer.byteLength(kept, "utf8"), why },
  };
}

export function createGitContentRenderer(): ContentRenderer {
  return {
    id: CONTENT_RENDERER_ID,
    kinds: ["diff", "commit"],
    renderAgentContent(object: ProducedObject): RenderedContent {
      return cap(
        object.renderings.agentContent,
        `${object.kind} content over ${AGENT_CONTENT_MAX_BYTES} bytes; the rest is in the workspace`,
      );
    },
    renderDelta(
      previous: ProducedObject,
      next: ProducedObject,
    ): RenderedContent {
      if (next.kind === "commit") {
        // A commit's content cannot change; a different commit is a different
        // object, so the only honest delta is which one this now is.
        return cap(
          previous.externalId === next.externalId
            ? `${next.title} (re-read; a commit's content does not change)`
            : `${previous.title} → ${next.title}`,
          "commit delta",
        );
      }
      return cap(diffDelta(previous, next), "diff delta");
    },
  };
}

interface FileLine {
  readonly status: string;
  readonly path: string;
}

/** The `- status: path` lines a diff's agent content lists, parsed back. */
function fileLines(object: ProducedObject): readonly FileLine[] {
  const lines: FileLine[] = [];
  for (const line of object.renderings.agentContent.split("\n")) {
    const match = /^- (added|modified|deleted|renamed): (.+)$/u.exec(line);
    if (match !== null) {
      lines.push({ status: match[1] as string, path: match[2] as string });
    }
  }
  return lines;
}

function diffDelta(previous: ProducedObject, next: ProducedObject): string {
  const before = new Map(fileLines(previous).map((one) => [one.path, one]));
  const after = new Map(fileLines(next).map((one) => [one.path, one]));

  const entered = [...after.keys()].filter((path) => !before.has(path));
  const left = [...before.keys()].filter((path) => !after.has(path));
  const changed = [...after.entries()]
    .filter(([path, one]) => {
      const was = before.get(path);
      return was !== undefined && was.status !== one.status;
    })
    .map(
      ([path, one]) => `${path} (${before.get(path)?.status} → ${one.status})`,
    );

  if (entered.length === 0 && left.length === 0 && changed.length === 0) {
    return "The same files are changed; their contents may differ.";
  }
  return [
    entered.length === 0 ? null : `Newly changed: ${entered.join(", ")}`,
    left.length === 0 ? null : `No longer changed: ${left.join(", ")}`,
    changed.length === 0 ? null : `Different change: ${changed.join(", ")}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

const CARD_LINE_LIMIT = 12;

/**
 * A declarative view the host draws (§10.1, §11): no markup and no component, so a
 * plugin cannot break focus management for the whole board. The compact card is what
 * a zoomed-out canvas shows; expanded lists the files — and says how many it did not
 * list rather than trailing off.
 */
export function createGitCardRenderer(): CardRenderer {
  return {
    id: CARD_RENDERER_ID,
    kinds: ["diff", "commit"],
    renderCard(object: ProducedObject, detail: CardDetail): CardView {
      if (detail === "compact") {
        return {
          title: object.title,
          lines: [object.renderings.card],
          actions: [],
        };
      }
      const files = fileLines(object);
      const shown = files.slice(0, CARD_LINE_LIMIT);
      const lines = [
        object.renderings.summary,
        ...shown.map((one) => `${one.status}: ${one.path}`),
      ];
      if (files.length > shown.length) {
        lines.push(
          `… and ${files.length - shown.length} more (open to see all)`,
        );
      }
      return { title: object.title, lines, actions: [] };
    },
  };
}
