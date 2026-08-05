import type { Theme } from "@plotroom/plugin-sdk";
import { PLOTROOM_THEME } from "@plotroom/toolkit";

/**
 * The compile-time proof that the toolkit's token map **is** the plugin SDK's
 * frozen `Theme` (#101, decision 0002 §1).
 *
 * The SDK froze `Theme { id, name, tokens: Record<string, string> }` with no
 * consumer, recording that it was waiting for the styling decision. This is that
 * consumer — and the assertion lives here rather than in the toolkit because
 * `@plotroom/toolkit` imports nothing from this workspace: the SDK's entry
 * reaches its worker host, and putting that in the design system would put Node
 * in a package the renderer bundles. `@plotroom/ui` is the one package that can
 * see both types, exactly like `apps/server/src/plugins/raise.ts`, which holds
 * the same kind of assertion for `PermissionRaise` and `ApprovalAsk`.
 *
 * Drift on either side is a build error rather than a surprise at runtime: widen
 * `Theme`, or change what `PLOTROOM_THEME` is, and this stops compiling.
 *
 * Nothing imports this module, and nothing should — it is an assertion, not a
 * seam. Applying the theme to product surfaces is #51.
 */
export const TOOLKIT_THEME: Theme = PLOTROOM_THEME;
