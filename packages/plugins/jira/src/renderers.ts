/**
 * Content and card renderers (§3.2, §10.1, §5).
 *
 * Three rules of §3.2 are mechanics here:
 *
 * - **Changes arrive as what's new, not just new state.** "OXY-2 moved to In Review and
 *   two children closed" is smaller and more actionable than a re-rendered epic.
 * - **Where a change is larger than the content, the full content stands in.** The delta
 *   is measured, and the whole thing is returned when the summary of the difference is
 *   not smaller than the thing itself.
 * - **Truncation is reported.** A capped rendering says how many bytes it dropped and
 *   why, so the surface displays that fact rather than hiding it (principle 12).
 *
 * The card renderer answers a **declarative view the host draws** — no markup, no
 * component — and carries the two gestures this plugin offers from a card:
 *
 * - **`expand-collection`** on an epic, which is §3.1's own verb for a collection
 *   ("a collection's verb is inspection: it expands, its members are individually
 *   draggable out"). It names **no write action**, because expanding writes nothing to
 *   Jira: the members are already objects the host holds, and the epic's content lists
 *   them by external id (see `model.ts`).
 * - **`transition`** on a ticket, which names the `transition` write action — so §6.6
 *   applies to a card button exactly as it does to the agent tool.
 *
 * Mechanics only: the design package has not landed, so nothing here decides how any of
 * it looks (the standing design gate in `AGENTS.md`).
 */
import type {
  CardDetail,
  CardRenderer,
  CardView,
  ContentRenderer,
  ProducedObject,
  RenderedContent,
} from "@plotroom/plugin-sdk";

import { TRANSITION_ACTION } from "./writes.js";

export const CONTENT_RENDERER_ID = "jira-content";
export const CARD_RENDERER_ID = "jira-card";
export const EXPAND_CARD_ACTION_ID = "expand-collection";
export const TRANSITION_CARD_ACTION_ID = TRANSITION_ACTION;

/** Generous for an epic with a hundred children, bounded so a novel cannot arrive silently. */
export const AGENT_CONTENT_MAX_BYTES = 64 * 1024;

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

export function createJiraContentRenderer(): ContentRenderer {
  return {
    id: CONTENT_RENDERER_ID,
    kinds: ["ticket", "collection", "document"],
    renderAgentContent(object: ProducedObject): RenderedContent {
      return cap(
        object.renderings.agentContent,
        `${object.kind} content over ${AGENT_CONTENT_MAX_BYTES} bytes; the rest is in Jira`,
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

export function createJiraCardRenderer(): CardRenderer {
  return {
    id: CARD_RENDERER_ID,
    kinds: ["ticket", "collection", "document"],
    renderCard(object: ProducedObject, detail: CardDetail): CardView {
      const actions =
        object.kind === "collection"
          ? [
              {
                id: EXPAND_CARD_ACTION_ID,
                label: "Expand this epic",
                // Not a write action: expanding writes nothing to Jira. The members
                // are listed in this object's content by external id (§3.1).
                writeActionId: null,
              },
            ]
          : object.kind === "ticket"
            ? [
                {
                  id: TRANSITION_CARD_ACTION_ID,
                  label: "Move this issue",
                  // A write from a card goes through §6.6 like any other.
                  writeActionId: TRANSITION_ACTION,
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
