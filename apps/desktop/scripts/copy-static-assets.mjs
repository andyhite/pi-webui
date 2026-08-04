#!/usr/bin/env node
/**
 * `tsc -b` only compiles `.ts` — the backend picker's static page
 * (`backend-picker.html`/`backend-picker.js`, deliberately unbundled, see
 * their own doc comments) has to be copied into `dist/` by hand so
 * `backend-picker-window.ts`'s `fileURLToPath(new URL("./backend-picker.html",
 * import.meta.url))` finds it next to the compiled `.js` at runtime, in
 * dev and in a packaged build alike.
 */
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");
const distDir = join(here, "..", "dist");

for (const name of ["backend-picker.html", "backend-picker.js"]) {
  copyFileSync(join(srcDir, name), join(distDir, name));
}

console.log("copied backend-picker static assets into dist/");
