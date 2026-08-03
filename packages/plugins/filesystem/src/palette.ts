/**
 * The Filesystem plugin's "Browse" entry (§9.4's "browse and drag", §10.1,
 * §11's command palette).
 *
 * **Declaration-only in contract v1.** `docs/plugin-contract.md` §6 lists
 * `PaletteEntry.invoke` among what is "not yet dispatched" — the type is
 * frozen, the wiring lands with the substrate. `invoke` below is a real,
 * harmless implementation (it only logs) rather than a stub that throws,
 * so the day the host does dispatch it, this plugin does not need editing to
 * stop erroring — but it is unreachable until then, and says so.
 *
 * The actual "browse" mechanism — listing a directory's immediate children —
 * is `producer.ts`'s `read` with `externalId: null` and `scope` set to the
 * configured root; that is what a future browse UI calls through
 * `concept.read`, not this entry.
 */
import type { PaletteEntry } from "@plotroom/plugin-sdk";

export const filesystemBrowsePaletteEntry: PaletteEntry = {
  id: "browse",
  label: "Browse files",
  description:
    "list a configured filesystem root's files and directories for dragging onto the canvas (§9.4)",
  invoke(context) {
    context.log(
      "filesystem browse invoked; PaletteEntry.invoke is declaration-only in contract v1 (§6) — the host does not dispatch this yet",
    );
  },
};
