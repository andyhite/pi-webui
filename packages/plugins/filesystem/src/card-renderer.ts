/**
 * The Filesystem plugin's card renderer (§10.1, §5, §9.4's "drag").
 *
 * Mechanics only, per the standing design gate (AGENTS.md, `development-plan.
 * md`'s "Design gate (Track B)"): a declarative `CardView` the host draws —
 * no colors, no icons, no layout, nothing beyond what `title`/`lines`/
 * `actions` already are. Visual design is a separate, later epic.
 *
 * Like `content-renderer.ts`, this never touches the filesystem again: it
 * reads only `object.renderings` (and the `card-meta.ts` JSON packed into
 * `renderings.card`), because `CardRenderer` is not permission-gated by the
 * host either.
 */
import type { CardRenderer } from "@plotroom/plugin-sdk";

import { decodeCardMeta } from "./card-meta.js";

export const filesystemCardRenderer: CardRenderer = {
  id: "fs-card",
  kinds: ["document"],
  renderCard(object, detail) {
    const meta = decodeCardMeta(object.renderings.card);
    const kind = meta?.fsKind ?? "document";
    const lines =
      detail === "expanded"
        ? [object.externalId, object.renderings.summary]
        : [];
    return {
      title: `${object.title} (${kind})`,
      lines,
      // No write actions exist for this plugin (browse/drag is read-only);
      // no actions to draw.
      actions: [],
    };
  },
};
