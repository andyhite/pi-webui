#!/usr/bin/env node
/**
 * Stages `apps/server` and `apps/web` for `electron-builder` (Epic 8.4).
 *
 * `apps/desktop`'s `main.ts` spawns the server as a *separate Node
 * process* rather than bundling it into the Electron app itself, so a
 * packaged build needs the server's own production `node_modules`
 * alongside its compiled `dist/` — pnpm's own virtual store
 * (`node_modules/.pnpm/...`) resolves those through *relative* symlinks,
 * which survive being copied wholesale (electron-builder's file copier
 * preserves symlinks as symlinks — verified directly) as long as the
 * whole tree moves together, so `pnpm deploy --prod` is staged straight
 * into its final destination with no flattening step. **Do not
 * dereference this tree** (`cp -L`/`fs.cpSync({dereference:true})`):
 * pnpm's strict, non-hoisted resolution depends on a package's *real*
 * on-disk location having its own private `node_modules` sibling inside
 * `.pnpm/` — flattening every symlink to its target's content, tried and
 * reverted here, copies each direct dependency's files but severs exactly
 * that sibling relationship, so a transitive dependency two hops down
 * (`@plotroom/db`'s own `better-sqlite3`) silently stopped resolving.
 * `electron-builder.yml`'s `extraResources` split (`node_modules` gets its
 * own entry, not a subpath of `server`'s) is the actual fix for the
 * problem the dereferencing was chasing — see its comment for what
 * `app-builder-lib` unconditionally excludes and why.
 *
 * The staged layout under `build/resources/` deliberately mirrors the dev
 * layout's *relative* structure (`apps/desktop`, `apps/server`, `apps/web`
 * as siblings): `main.ts`'s `SERVER_ENTRY` and `apps/server`'s
 * `defaultStaticDir()` each resolve their sibling path from their own
 * compiled file's `import.meta.url`, unchanged between dev and packaged —
 * see `electron-builder.yml`'s `extraResources` comment for the exact
 * math, and `docs/deployment.md` for the end-to-end picture.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
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
run("pnpm", ["--filter", "@plotroom/server", "build"], repoRoot);
run("pnpm", ["--filter", "@plotroom/web", "build"], repoRoot);

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

console.log(
  `deploying @plotroom/server (production deps only) to ${serverStageDir}...`,
);
run(
  "pnpm",
  ["--filter", "@plotroom/server", "deploy", "--prod", serverStageDir],
  repoRoot,
);

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
