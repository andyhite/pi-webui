/**
 * The Filesystem plugin's content renderer (§10.1, §3.2, principle 12).
 *
 * **Deliberately does not touch the filesystem.** `ContentRenderer` carries no
 * `permissions` field in the frozen contract (unlike `ConceptProducer`,
 * `WriteAction`, `ConditionCheck`, `NotificationRoute`, and `WorkspaceKind`,
 * which all do — `docs/plugin-contract.md` §7 item 7) and the host does not
 * gate this contribution's invocations against any grant. A renderer that
 * re-opened the file at `object.externalId` on every call would be reading
 * disk **outside the one gate the contract enforces** — an ungated second
 * path to the same reach the producer's declared `fs-read` permission was
 * supposed to cover. Instead this renderer derives everything from the
 * `ProducedObject` the (permission-gated) producer already returned, via the
 * `card-meta.ts` JSON it packed into `renderings.card` — no I/O here at all.
 *
 * That is also this batch's clearest finding about what the contract can't
 * express: `Renderings` (the producer's shape) has no truncation field, only
 * `RenderedContent` (this contribution's shape) does, so surfacing "no silent
 * truncation" (principle 12) through the contract's own dedicated mechanism
 * requires a content renderer at all, even though the producer's inline
 * `agentContent` already states the same fact in text.
 *
 * `renderDelta` computes no real diff: per §3.2, "where a change is larger
 * than the content, the full content stands in" — the next version's full
 * content stands in exactly as it does for a plugin with no delta model.
 */
import type { ContentRenderer } from "@plotroom/plugin-sdk";

import { decodeCardMeta } from "./card-meta.js";

export const filesystemContentRenderer: ContentRenderer = {
  id: "fs-content",
  kinds: ["document"],
  renderAgentContent(object) {
    const meta = decodeCardMeta(object.renderings.card);
    return {
      content: object.renderings.agentContent,
      truncated: meta?.truncated ?? null,
    };
  },
  renderDelta(_previous, next) {
    const meta = decodeCardMeta(next.renderings.card);
    return {
      content: next.renderings.agentContent,
      truncated: meta?.truncated ?? null,
    };
  },
};
