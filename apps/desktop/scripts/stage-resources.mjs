#!/usr/bin/env node
/**
 * Stages `apps/server` and `apps/web` for `electron-builder` (Epic 8.4).
 *
 * `apps/desktop`'s `main.ts` spawns the server as a *separate Node
 * process* rather than bundling it into the Electron app itself, so a
 * packaged build needs the server's own production `node_modules`
 * alongside its compiled `dist/`.
 *
 * `turbo prune @plotroom/server --production` (#310, replacing
 * `bunx turbo prune @plotroom/server --production`) writes a self-contained
 * subset workspace — every package `@plotroom/server` depends on, their
 * `package.json`s, a pruned `bun.lock`, and `turbo.json`/`bunfig.toml` — into
 * a scratch directory, preserving the monorepo's `apps/`/`packages/` layout
 * (unlike pnpm's flat `deploy`). A frozen `bun install` there resolves the
 * subset with the isolated linker, so `apps/server/node_modules/<pkg>` is a
 * symlink into that scratch tree's own `node_modules/.bun` store — real only
 * as long as the scratch tree exists. `dereference: true` on both copies
 * below resolves every such symlink to real file content *before* the
 * scratch tree is deleted, so `build/resources/server` ends up flat
 * (`server/dist`, `server/node_modules`, `server/package.json`) exactly like
 * the pnpm `deploy` output it replaces — `electron-builder.yml`'s
 * `extraResources` split expects that shape, unchanged.
 *
 * The staged layout deliberately mirrors the dev layout's *relative*
 * structure (`apps/desktop`, `apps/server`, `apps/web` as siblings):
 * `main.ts`'s `SERVER_ENTRY` and `apps/server`'s `defaultStaticDir()` each
 * resolve their sibling path from their own compiled file's
 * `import.meta.url`, unchanged between dev and packaged — see
 * `electron-builder.yml`'s `extraResources` comment for the exact math, and
 * `docs/deployment.md` for the end-to-end picture.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(here, "..");
const repoRoot = join(desktopDir, "..", "..");
const buildDir = join(desktopDir, "build", "resources");
const serverStageDir = join(buildDir, "server");
const webStageDir = join(buildDir, "web");

function run(command, args, cwd) {
  console.log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

console.log("building @plotroom/server and @plotroom/web...");
run("bunx", ["turbo", "run", "build", "--filter=@plotroom/server"], repoRoot);
run("bunx", ["turbo", "run", "build", "--filter=@plotroom/web"], repoRoot);

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

const pruneDir = mkdtempSync(join(tmpdir(), "plotroom-server-prune-"));
console.log(
  `pruning @plotroom/server (production deps only) into ${pruneDir}...`,
);
run(
  "bunx",
  [
    "turbo",
    "prune",
    "@plotroom/server",
    "--production",
    `--out-dir=${pruneDir}`,
    "--use-gitignore=false",
  ],
  repoRoot,
);
run(
  "bun",
  [
    "install",
    "--frozen-lockfile",
    "--production",
    "--ignore-scripts",
    "--linker",
    "hoisted",
  ],
  pruneDir,
);
// The root build above produced every required `dist/`. `--use-gitignore=false`
// copies those artifacts into the pruned tree, so this production install does
// not need the dev-only TypeScript/config packages to compile a second time.
console.log(`staging pruned server into ${serverStageDir}...`);
mkdirSync(serverStageDir, { recursive: true });
const prunedServerDir = join(pruneDir, "apps", "server");
cpSync(prunedServerDir, serverStageDir, {
  recursive: true,
  dereference: true,
  filter: (src) => !src.includes(`${prunedServerDir}/node_modules`),
});
// Follow the top-level Bun links into real package content, but omit nested
// workspace `node_modules` links: those are dev/config links stripped by the
// production install and are intentionally not runtime dependencies.
run(
  "rsync",
  [
    "-aL",
    "--exclude=node_modules/**",
    `${join(pruneDir, "node_modules")}/`,
    `${join(serverStageDir, "node_modules")}/`,
  ],
  repoRoot,
);
rmSync(pruneDir, { recursive: true, force: true });

const webDistSource = join(repoRoot, "apps", "web", "dist");
if (!existsSync(webDistSource)) {
  throw new Error(
    `expected ${webDistSource} to exist after building @plotroom/web`,
  );
}
console.log(`copying ${webDistSource} to ${join(webStageDir, "dist")}...`);
mkdirSync(webStageDir, { recursive: true });
cpSync(webDistSource, join(webStageDir, "dist"), { recursive: true });

console.log("staged resources ready for electron-builder:");
console.log(`  ${serverStageDir}`);
console.log(`  ${webStageDir}`);
