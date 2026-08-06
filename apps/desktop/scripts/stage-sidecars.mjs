#!/usr/bin/env node
// Stages the compiled server + session-host artifacts for Tauri (#316).
//
// Tauri's two mechanisms for shipping a foreign binary are not
// interchangeable, per #308's S2 finding #1: `bundle.externalBin` assumes a
// single executable per target triple, while the session-host artifact is a
// *directory* (its binary plus ~155MB of native-addon `.node` files that
// must sit beside it at runtime). So:
//
//   - the server binary -> `src-tauri/binaries/plotroom-server-<triple>`
//     (externalBin's required naming; Tauri strips the triple back off at
//     resolve time)
//   - the session-host binary + its addon files -> `src-tauri/resources/`
//     (co-located, resolved by this app's own Rust code via
//     `resource_dir()`, then threaded to the server as `PLOTROOM_SESSION_HOST`
//     — see `src/sidecar.rs`)
//   - `apps/web`'s built renderer -> `src-tauri/resources/web-dist/`
//     (threaded to the spawned server as `PLOTROOM_STATIC_DIR` — the
//     compiled server binary has no on-disk sibling `apps/web` to find its
//     own default static dir against, so this always has to be stated
//     explicitly for a packaged sidecar to serve the canvas)
//
// Run after `bun run --filter=@plotroom/server compile` and
// `bun run --filter=@plotroom/session-host compile`, before `cargo tauri
// build`/`cargo tauri dev`. Never run by hand in CI — the packaging job
// wires this in as its own step (see `.github/workflows/ci.yml`).
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";

const desktopDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = join(desktopDir, "..", "..");
const srcTauriDir = join(desktopDir, "src-tauri");
const binariesDir = join(srcTauriDir, "binaries");
const resourcesDir = join(srcTauriDir, "resources");
const webDistResourceDir = join(resourcesDir, "web-dist");

function targetTriple() {
  // `rustc -vV`'s `host:` line is the one source of truth for "what triple
  // is this machine" — duplicating cargo's own logic here would drift.
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
  const triple = targetTriple();
  mkdirSync(binariesDir, { recursive: true });
  mkdirSync(resourcesDir, { recursive: true });

  const serverBinary = join(
    repoRoot,
    "apps/server/out",
    `plotroom-server${exeSuffix()}`,
  );
  if (!existsSync(serverBinary)) {
    throw new Error(
      `${serverBinary} does not exist — run \`bun run --filter=@plotroom/server compile\` first`,
    );
  }
  const stagedServer = join(
    binariesDir,
    `plotroom-server-${triple}${exeSuffix()}`,
  );
  copyFileSync(serverBinary, stagedServer);

  const sessionHostDir = join(repoRoot, "apps/session-host/out");
  if (!existsSync(sessionHostDir)) {
    throw new Error(
      `${sessionHostDir} does not exist — run \`bun run --filter=@plotroom/session-host compile\` first`,
    );
  }
  for (const file of readdirSync(sessionHostDir)) {
    copyFileSync(join(sessionHostDir, file), join(resourcesDir, file));
  }

  // The spawned server's own default static-dir resolution has no on-disk
  // sibling `apps/web` once it is a standalone compiled binary (see
  // `src/sidecar.rs`'s `SidecarLayout` doc comment) -- co-locating the built
  // renderer here is what `PLOTROOM_STATIC_DIR` points the sidecar at.
  const webDist = join(repoRoot, "apps/web/dist");
  if (!existsSync(webDist)) {
    throw new Error(
      `${webDist} does not exist — run \`bun run --filter=@plotroom/web build\` first`,
    );
  }
  cpSync(webDist, webDistResourceDir, { recursive: true });

  process.stdout.write(
    `staged sidecars for ${triple}:\n  ${stagedServer}\n  ${resourcesDir}/* (${readdirSync(resourcesDir).join(", ")})\n  ${webDistResourceDir}/\n`,
  );
}

main();
