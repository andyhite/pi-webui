#!/usr/bin/env node
/**
 * Runs `electron-builder` with the product version injected from the **root**
 * manifest (decision 0003 §5, #94).
 *
 * There is one product version and it lives in `/package.json`. Every
 * workspace package, this one included, stays `private` at `0.0.0`
 * permanently (0003 §1) — a version on an unpublished package is a number
 * nobody reads, and a second copy of the real one is a number that drifts.
 * So the installer's version is not read from `apps/desktop/package.json`; it
 * is passed in here, at packaging time, as `extraMetadata.version`.
 *
 * That reaches everything electron-builder derives from a version, including
 * `electron-builder.yml`'s `artifactName` macro and the `app.getVersion()`
 * the updater compares against a feed — which is the point: those must agree
 * with the git tag, and the tag comes from the same root manifest.
 *
 * A wrapper rather than a shell substitution in the pnpm script, because
 * `$(node -p …)` is not portable to the Windows runner that builds the NSIS
 * installer.
 *
 * Extra arguments are forwarded, so `--linux` and friends still work.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

const rootManifest = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
);
const version = rootManifest.version;
if (typeof version !== "string" || version === "") {
  throw new Error(
    `no version in ${join(repoRoot, "package.json")}; \`pnpm release\` is what sets it`,
  );
}

// `0.0.0` means nothing has been released yet. Packaging is still allowed —
// a local build of an untagged tree is a normal thing to want — but it says
// so, because an installer called 0.0.0 is not one to hand anybody.
if (version === "0.0.0") {
  console.warn(
    "package: the root manifest is still 0.0.0, so this installer is an unreleased local build",
  );
}

const args = [
  "build",
  "--config",
  "electron-builder.yml",
  `-c.extraMetadata.version=${version}`,
  ...process.argv.slice(2),
];

console.log(`package: electron-builder ${args.join(" ")}`);
execFileSync("pnpm", ["exec", "electron-builder", ...args], {
  cwd: join(here, ".."),
  stdio: "inherit",
});
