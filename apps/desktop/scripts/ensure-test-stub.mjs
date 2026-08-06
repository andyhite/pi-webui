#!/usr/bin/env node
// `cargo build`/`cargo test` on this crate -- not only `cargo tauri build` --
// runs tauri-build's own build script, which reads `tauri.conf.json`'s
// `bundle.externalBin` and fails the whole compile if the named file is
// missing (discovered when CI's plain `cargo test` failed with "resource
// path `binaries/plotroom-server-<triple>` doesn't exist": nothing in that
// job's steps ever runs `stage-sidecars.mjs`, and it shouldn't have to --
// compiling and testing this crate's own Rust code needs no real server
// binary, only *a* file at that path).
//
// So: an empty, non-executable placeholder, written only when nothing is
// there yet -- never overwrites what `stage-sidecars.mjs` (a real compiled
// server) or a previous packaging step already staged.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const desktopDir = dirname(dirname(fileURLToPath(import.meta.url)));
const binariesDir = join(desktopDir, "src-tauri", "binaries");

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
  if (existsSync(stubPath)) {
    return;
  }
  writeFileSync(stubPath, "");
  process.stdout.write(`wrote a test-only stub sidecar at ${stubPath}\n`);
}

main();
