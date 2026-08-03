/**
 * GitHub's palette entry (§10.1, §11), in a leaf module of its own so the
 * renderer half of this plugin (`renderer-manifest.ts`) can carry it without
 * importing the transport-bound host manifest.
 */
import type { PaletteEntry } from "@plotroom/plugin-sdk";

export const CLONE_PALETTE_ENTRY_ID = "github-clone-from-pull-request";

export const githubClonePaletteEntry: PaletteEntry = {
  id: CLONE_PALETTE_ENTRY_ID,
  label: "GitHub: clone a repository from a pull request",
  description:
    "Take a pull request card's repository as a workspace, cloned by the host's own git over the host's own authentication (§3.4).",
  // All a palette entry can do in contract v1: `invoke` answers nothing and
  // the call context holds no reach into the host, so the gesture itself is
  // the card action's `clone-from-pull-request` and the host performing it.
  // Reported as a contract finding rather than worked around.
  invoke: (context) => {
    context.log(
      "clone-from-pull-request was invoked; the clone itself is the host's, over the host's own git authentication (§3.4)",
    );
  },
};
