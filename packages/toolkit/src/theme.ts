import { DESIGN_TOKENS } from "./tokens.js";

/**
 * The token table's typed half (decision 0002 §1).
 *
 * This is the shape the plugin SDK's `Theme` froze with no consumer, waiting for
 * the styling decision: `{ id, name, tokens: Record<string, string> }`. It is
 * declared here rather than imported because the toolkit depends on no other
 * workspace package — the SDK's entry reaches its worker host, and the renderer
 * bundles this package. `@plotroom/ui` holds the compile-time proof that the two
 * shapes still agree (`src/theme/sdk-contract.ts`), because it is the one
 * package that can see both.
 *
 * A theme is a token override, never a stylesheet, which is why this is a flat
 * map of custom-property names to values: an operator's theme or a plugin's is
 * the same kind of thing as this one.
 */
export interface TokenTheme {
  readonly id: string;
  readonly name: string;
  readonly tokens: Readonly<Record<string, string>>;
}

/** The one theme the design defines. §18: "Dark only. There is no light theme." */
export const PLOTROOM_THEME_ID = "plotroom.glass";

/**
 * The committed visual direction: Glass on `#101113`.
 *
 * Keys are §18's `--pr-*` names, so the code and the spec share a vocabulary and
 * a theme override names the same things the design does.
 */
export const PLOTROOM_THEME: TokenTheme = {
  id: PLOTROOM_THEME_ID,
  name: "Glass",
  tokens: Object.freeze(
    Object.fromEntries(
      DESIGN_TOKENS.map((token) => [token.name, token.value]),
    ) as Record<string, string>,
  ),
};
