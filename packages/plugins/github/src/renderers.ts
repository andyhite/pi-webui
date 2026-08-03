/**
 * Content and card renderers (§3.2, §10.1, §5).
 *
 * Three rules of §3.2 are mechanics here:
 *
 * - **Changes arrive as what's new, not just new state.** "Four new review comments
 *   arrived" is smaller and more actionable than a re-rendered pull request.
 * - **Where a change is larger than the content, the full content stands in.** The
 *   delta is measured, and the whole thing is returned when the summary of the
 *   difference is not smaller than the thing itself.
 * - **Truncation is reported.** A capped rendering says how many bytes it dropped and
 *   why, so the surface displays that fact rather than hiding it (principle 12).
 *
 * The card renderer answers a **declarative view the host draws** — no markup, no
 * component — and it carries the §3.4 gesture this plugin exists to offer: **clone
 * from a pull request's card**. That action names no `writeActionId` on purpose: the
 * clone is the *host's* git over the host's own authentication, never this plugin's
 * token (§3.4), so the card offers the gesture and supplies the clone URL, and the
 * host performs it through the git workspace kind.
 */
import type {
  CardDetail,
  CardRenderer,
  CardView,
  ContentRenderer,
  ProducedObject,
  RenderedContent,
} from "@plotroom/plugin-sdk";

export const CONTENT_RENDERER_ID = "github-content";
export const CARD_RENDERER_ID = "github-card";
export const CLONE_CARD_ACTION_ID = "clone-from-pull-request";

/** Generous for a pull request body, bounded so a novel cannot arrive silently. */
export const AGENT_CONTENT_MAX_BYTES = 64 * 1024;

/**
 * `TextEncoder`/`TextDecoder` rather than `Buffer`: this module is a *renderer*
 * contribution, and the host calling it may be a browser tab (`@plotroom/ui`'s
 * `ContributionRegistry`) where `Buffer` does not exist. A cap that threw there
 * would be truncation reported as a broken renderer, which is the one thing
 * principle 12 forbids.
 */
export function cap(content: string, why: string): RenderedContent {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(content);
  if (encoded.length <= AGENT_CONTENT_MAX_BYTES) {
    return { content, truncated: null };
  }
  const kept = new TextDecoder("utf-8").decode(
    encoded.subarray(0, AGENT_CONTENT_MAX_BYTES),
  );
  return {
    content: kept,
    truncated: {
      omittedBytes: encoded.length - encoder.encode(kept).length,
      why,
    },
  };
}

export function createGitHubContentRenderer(): ContentRenderer {
  return {
    id: CONTENT_RENDERER_ID,
    kinds: ["pull_request", "review", "ticket", "document"],
    renderAgentContent(object: ProducedObject): RenderedContent {
      return cap(
        object.renderings.agentContent,
        `${object.kind} content over ${AGENT_CONTENT_MAX_BYTES} bytes; the rest is on GitHub`,
      );
    },
    renderDelta(
      previous: ProducedObject,
      next: ProducedObject,
    ): RenderedContent {
      const delta = lineDelta(
        previous.renderings.agentContent,
        next.renderings.agentContent,
      );
      const whole = next.renderings.agentContent;
      // Where a change is larger than the content, the full content stands in (§3.2).
      const content =
        delta === null
          ? `${next.title} was re-read and reads the same.`
          : delta.length >= whole.length
            ? whole
            : delta;
      return cap(content, "delta over the maximum agent content size");
    },
  };
}

/** What's new between two renderings, as lines that entered and lines that left. */
export function lineDelta(previous: string, next: string): string | null {
  const before = previous.split("\n");
  const after = next.split("\n");
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const entered = after.filter(
    (line) => line.trim() !== "" && !beforeSet.has(line),
  );
  const left = before.filter(
    (line) => line.trim() !== "" && !afterSet.has(line),
  );
  if (entered.length === 0 && left.length === 0) {
    return null;
  }
  return [
    entered.length === 0 ? null : `## New\n${entered.join("\n")}`,
    left.length === 0 ? null : `## Gone\n${left.join("\n")}`,
  ]
    .filter((section): section is string => section !== null)
    .join("\n\n");
}

/** The clone URL a pull request's content carries, for the host's own git (§3.4). */
export function cloneUrlOf(object: ProducedObject): string | null {
  const match = /^Clone(?: \(https\))?: (\S+)$/mu.exec(
    object.renderings.agentContent,
  );
  return match === null ? null : (match[1] as string);
}

export function createGitHubCardRenderer(): CardRenderer {
  return {
    id: CARD_RENDERER_ID,
    kinds: ["pull_request", "review", "ticket", "document"],
    renderCard(object: ProducedObject, detail: CardDetail): CardView {
      const cloneUrl = cloneUrlOf(object);
      const actions =
        object.kind === "pull_request" && cloneUrl !== null
          ? [
              {
                id: CLONE_CARD_ACTION_ID,
                label: "Clone this repository",
                // Not a write action: the clone is the host's git over the host's
                // own authentication, never this plugin's token (§3.4).
                writeActionId: null,
              },
            ]
          : [];

      if (detail === "compact") {
        return {
          title: object.title,
          lines: [object.renderings.card],
          actions,
        };
      }
      const lines = object.renderings.agentContent
        .split("\n")
        .filter((line) => line.trim() !== "")
        .slice(0, 14);
      return {
        title: object.title,
        lines: [object.renderings.summary, ...lines],
        actions,
      };
    },
  };
}
