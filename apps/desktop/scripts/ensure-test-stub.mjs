#!/usr/bin/env node
// `cargo build`/`cargo test` on this crate -- not only `cargo tauri build` --
// runs tauri-build's own build script, which reads `tauri.conf.json`'s
// `bundle.externalBin` and `bundle.resources` and fails the whole compile if
// either is missing or (for `resources`) its glob matches nothing (discovered
// when CI's plain `cargo test` failed first with "resource path
// `binaries/plotroom-server-<triple>` doesn't exist", then, once that was
// stubbed, with "glob pattern resources/**/* path not found or didn't match
// any files"). Once tauri-build's own script is satisfied, compiling
// `src/lib.rs` itself hits a third check: `tauri::generate_context!()` (a
// proc macro, so this runs on every `cargo build`/`test`/`clippy`, not only
// `cargo tauri build`) requires `tauri.conf.json`'s `build.frontendDist`
// (`../../web/dist`, i.e. `apps/web/dist`) to exist too -- and nothing in
// this job's steps builds `@plotroom/web` first, unlike the real desktop
// packaging job (`.github/workflows/ci.yml`'s `desktop-package`), which
// always does. `frontendDist` is otherwise unused at runtime by this shell
// (`sidecar.rs`'s `SidecarLayout::packaged` doc comment: it loads the
// server's own URL, not Tauri's asset protocol), so a placeholder is exactly
// as good as the real thing for this compile-time-only check.
//
// So: empty, non-executable placeholders, written only when nothing is
// there yet -- never overwrites what `stage-sidecars.mjs`/a real
// `@plotroom/web` build already produced.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const desktopDir = dirname(dirname(fileURLToPath(import.meta.url)));
const binariesDir = join(desktopDir, "src-tauri", "binaries");
const resourcesDir = join(desktopDir, "src-tauri", "resources");
const webDistDir = join(desktopDir, "..", "web", "dist");

function targetTriple() {
  const output = execSync("rustc -vV", { encoding: "utf8" });
  const line = output.split("\n").find((l) => l.startsWith("host:"));
  if (!line) {
    throw new Error(
      "could not determine the host target triple from `rustc -vV`",
    );
  }
  return line.replace("host:", "").trim();
}

function exeSuffix() {
  return process.platform === "win32" ? ".exe" : "";
}

function main() {
  mkdirSync(binariesDir, { recursive: true });
  const triple = targetTriple();
  const stubPath = join(binariesDir, `plotroom-server-${triple}${exeSuffix()}`);
  if (!existsSync(stubPath)) {
    writeFileSync(stubPath, "");
    process.stdout.write(`wrote a test-only stub sidecar at ${stubPath}\n`);
  }

  mkdirSync(resourcesDir, { recursive: true });
  if (readdirSync(resourcesDir).length === 0) {
    const resourceStubPath = join(resourcesDir, ".test-stub");
    writeFileSync(resourceStubPath, "");
    process.stdout.write(
      `wrote a test-only stub resource at ${resourceStubPath}\n`,
    );
  }

  mkdirSync(webDistDir, { recursive: true });
  if (readdirSync(webDistDir).length === 0) {
    const indexPath = join(webDistDir, "index.html");
    writeFileSync(indexPath, "<!doctype html>\n<title>test stub</title>\n");
    process.stdout.write(`wrote a test-only stub renderer at ${indexPath}\n`);
  }
}

main();
