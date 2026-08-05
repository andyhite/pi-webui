import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

import { renderThemeCss, sameContent } from "./src/theme.css.js";

const here = dirname(fileURLToPath(import.meta.url));
const generated = resolve(here, "src/theme.generated.css");

/**
 * The token layer's codegen (decision 0002 §1): `src/tokens.ts` is the source,
 * and `src/theme.generated.css` is its CSS half, which `src/toolkit.css` imports.
 *
 * The output is **committed**, not ignored, because a design change should land
 * as a reviewable CSS diff — that is why decision 0002 chose custom properties
 * over a stylesheet in the first place.
 *
 * Which means the build **checks** rather than writes. A build that quietly
 * regenerated it would repair a stale commit on the CI runner before anything
 * compared the two — `pnpm verify` runs `typecheck` first, and turbo schedules
 * this package's `build` inside it because `@plotroom/ui` references it — so the
 * file that landed in the repo could disagree with the table with nothing
 * failing. Writing is the explicit gesture `pnpm --filter @plotroom/toolkit
 * tokens:emit` (this same build in Vite's `emit` mode), and both this and
 * `theme.css.test.ts` refuse a stale file.
 */
function checkThemeCss(write: boolean): Plugin {
  return {
    name: "plotroom:theme-css",
    buildStart() {
      const next = renderThemeCss();
      let current: string | null = null;
      try {
        current = readFileSync(generated, "utf8");
      } catch {
        current = null;
      }
      // Compared as content, not bytes: with no `.gitattributes` in this
      // repository a Windows checkout has CRLF on disk while the renderer emits
      // LF, and a gate that read that as a design change made the package
      // unbuildable on Windows for a difference nobody made.
      if (current !== null && sameContent(current, next)) return;
      if (!write) {
        throw new Error(
          `src/theme.generated.css is stale: it is not what src/tokens.ts renders. ` +
            `Regenerate it with \`pnpm --filter @plotroom/toolkit tokens:emit\` and commit the diff.`,
        );
      }
      mkdirSync(dirname(generated), { recursive: true });
      writeFileSync(generated, next, "utf8");
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [checkThemeCss(mode === "emit"), tailwindcss()],
  build: {
    // `tsc -b` writes the declarations into this same directory and runs first,
    // so Vite must not empty it: the default would delete `dist/index.d.ts` —
    // the package's own `types` target — and `dist/.tsbuildinfo` with it, and
    // `turbo run typecheck` can schedule this package's `build` and `typecheck`
    // concurrently, so one would be removing what the other is writing.
    emptyOutDir: false,
    // Library mode defaults this to `false`, and with it false Vite refuses a
    // `.css` entry outright. The CSS is an entry rather than an import from
    // `src/index.ts` on purpose: consumers resolve this package through its
    // `source` export condition (raw TypeScript, see `apps/web/vite.config.ts`)
    // and their build has no Tailwind plugin, so a CSS import in the TS entry
    // would break their dev server.
    cssCodeSplit: true,
    lib: {
      // The stylesheet's filename comes from this key — `build.lib.cssFileName`
      // is only consulted on the `cssCodeSplit: false` path and would be dead
      // config here.
      entry: { index: "src/index.ts", toolkit: "src/toolkit.css" },
      // ESM only: the renderer is the only consumer, and every extra format
      // makes Tailwind generate the same stylesheet again.
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
  },
}));
