import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { packageTests } from "../vitest.base.config.ts";

/**
 * What is left of the build tooling contract (#215) after #307 moved most of
 * it into lint rules (`packages/config/eslint-config/rules/`,
 * wired per-package from `eslint.config.js` and run by `pnpm lint:arch`):
 * every convention a lint rule can check by reading one file — a
 * `package.json`'s scripts, a `tsconfig*.json`'s shape — now lives there
 * instead of here.
 *
 * What is left here is genuinely graph-shaped: it needs to see the whole
 * workspace (glob membership), correlate two different files per package
 * (a source importing `node:` against its manifest's declared types), or
 * import a config module at runtime to compare object identity. A lint rule
 * visits one file at a time and cannot express any of that.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * Packages whose own `dist/` is under test — their host suites load the built
 * plugin entry in a worker, which is exactly what the product loads — so `test`
 * builds first. Turbo's `test` task depends on `^build`, upstream only, and a
 * cold cache is where the difference showed (#118). Mirrors the
 * `buildsOwnDist` option each such package's `eslint.config.js` passes to
 * `plotroom/package-json-conventions`.
 */
const BUILDS_ITS_OWN_DIST: Record<string, string> = {
  "packages/plugins/git": "host.integration.test.ts loads ../dist/index.js",
  "packages/plugins/github":
    "host.integration.test.ts loads ../dist/index.js and ../dist/testing/stub-entry.js",
  "packages/plugins/jira":
    "host.integration.test.ts loads ../dist/index.js and ../dist/testing/stub-entry.js",
};

/**
 * The one package that is not on vitest: it runs on Bun, its tests import
 * `bun:test`, and it embeds a Bun-only SDK (decision 0005). A vitest
 * configuration here would be a second runner claiming the same files.
 * Mirrors the `testOverride` option `apps/session-host/eslint.config.js`
 * passes to `plotroom/package-json-conventions`.
 */
const NOT_VITEST: Record<string, { test: string; why: string }> = {
  "apps/session-host": {
    test: "bun test src",
    why: "Bun runtime, `bun:test` (decision 0005)",
  },
};

/** Packages that get Node's types from something other than `@types/node`. */
const NODE_TYPES_FROM: Record<string, string> = {
  "apps/session-host": "@types/bun",
};

/**
 * The shared config packages themselves (#306): pure JSON/JS, no `src/`, no
 * build/typecheck/test scripts — they are what every other package's
 * contract points *at*, not a package the per-package contract applies to.
 */
const CONFIG_PACKAGES: Record<string, string> = {
  "packages/config/typescript-config":
    "base.json/tests.json only, no tsconfig of its own",
  "packages/config/eslint-config":
    "index.js only, no tsconfig/vitest config of its own",
};

type Manifest = {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

/** JSON with line and block comments, which is what a tsconfig is. */
function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charAt(i);
    const next = text.charAt(i + 1);
    if (inLineComment) {
      if (c === "\n") {
        inLineComment = false;
        out += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      } else if (c === "\n") {
        out += c;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next;
        i += 1;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    out += c;
  }
  return JSON.parse(out) as unknown;
}

/** What the root `package.json`'s `workspaces` globs expand to on disk. */
function workspace(): { globs: string[]; entries: number; dirs: string[] } {
  const manifest = parseJsonc(read("package.json")) as { workspaces?: unknown };
  const globs = Array.isArray(manifest.workspaces)
    ? manifest.workspaces.filter((g): g is string => typeof g === "string")
    : [];
  if (globs.length === 0)
    throw new Error("package.json declares no workspaces");
  const dirs: string[] = [];
  for (const glob of globs) {
    const parent = glob.replace(/\/\*$/, "");
    if (parent === glob) throw new Error(`unhandled workspace glob: ${glob}`);
    for (const entry of readdirSync(join(repoRoot, parent), {
      withFileTypes: true,
    })) {
      const dir = `${parent}/${entry.name}`;
      if (!entry.isDirectory()) continue;
      if (existsSync(join(repoRoot, dir, "package.json"))) dirs.push(dir);
    }
  }
  return { globs, entries: globs.length, dirs: dirs.sort() };
}

/** Every `.ts`/`.tsx` file under a package's `src/`, tests included. */
function sources(dir: string): string[] {
  const found: string[] = [];
  const walk = (from: string): void => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const path = join(from, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) found.push(path);
    }
  };
  walk(join(repoRoot, dir, "src"));
  return found;
}

const { globs, entries, dirs } = workspace();
const packages = dirs.map((dir) => ({
  dir,
  manifest: parseJsonc(read(`${dir}/package.json`)) as Manifest,
}));

describe("the packages this contract covers", () => {
  it("is every one the workspaces globs expand to", () => {
    // A glob this test failed to parse would make every assertion below vacuous
    // for that whole family of packages. The `name` scope itself
    // (`^@plotroom/`) is `plotroom/package-json-conventions` now; workspace
    // membership is not a single-file check a lint rule can make.
    expect(globs).toHaveLength(entries);
    expect(packages.map((p) => p.dir)).toContain("packages/core");
    expect(packages.map((p) => p.dir)).toContain("apps/session-host");
  });

  it("is what every deviation names, so a stale exception cannot hide", () => {
    const claimed = Object.keys({
      ...BUILDS_ITS_OWN_DIST,
      ...NOT_VITEST,
      ...NODE_TYPES_FROM,
    });
    expect(claimed.filter((dir) => !dirs.includes(dir))).toEqual([]);
  });
});

describe("what the shape reaches", () => {
  it("is `src/**/*.test.ts`, and no package writes a test it would miss", () => {
    // Both halves of the shape name that one pattern: the build excludes it and
    // the shared vitest include collects it. A `*.test.tsx` would therefore be
    // emitted into `dist/` and never run, and `.spec.ts` is Playwright's suffix
    // here (`apps/web/e2e`), a suite vitest must not collect. Widening the
    // shape is a deliberate edit to both patterns, not a file somebody adds —
    // and it needs to walk every package's sources, which a lint rule cannot.
    const stray = packages
      .filter(({ dir }) => !(dir in CONFIG_PACKAGES))
      .flatMap(({ dir }) =>
        sources(dir)
          .filter((file) => /\.(test\.tsx|spec\.tsx?)$/.test(file))
          .map((file) => relative(repoRoot, file)),
      );
    expect(stray).toEqual([]);
  });

  it("declares Node's types in the package that imports a `node:` builtin", () => {
    // One direction only, deliberately: `@types/node` also supplies globals no
    // import names (`Buffer` in `packages/plugins/jira/src/transport.ts`,
    // `fetch` under a DOM-less `lib`), so an unused declaration cannot be
    // detected by grepping for specifiers — only by removing it and typechecking.
    // Correlating a package's sources with its manifest is two files, not one:
    // outside what `plotroom/package-json-conventions` can check per-file.
    const undeclared = packages
      .filter(({ dir }) => !(dir in CONFIG_PACKAGES))
      .filter(({ dir, manifest }) => {
        const importsNode = sources(dir).some((file) =>
          /["']node:/.test(readFileSync(file, "utf8")),
        );
        if (!importsNode) return false;
        const declared = {
          ...manifest.dependencies,
          ...manifest.devDependencies,
        };
        return !((NODE_TYPES_FROM[dir] ?? "@types/node") in declared);
      })
      .map((p) => p.dir);
    expect(undeclared).toEqual([]);
  });
});

describe.each(
  packages.filter(
    ({ dir }) => !(dir in CONFIG_PACKAGES) && !(dir in NOT_VITEST),
  ),
)("$dir", ({ dir }) => {
  it("takes its test include from the shared base, not a copy of it", async () => {
    // Runtime-selected specifier: one assertion over every package's config,
    // and the point is the object vitest really loads rather than its text.
    // Identity, not equality: `mergeConfig` keeps the base's array by
    // reference, so this passes for the three packages that add a timeout and
    // fails for a config that restates the pattern — which is the whole point
    // of the pattern living in one file. A lint rule reads a file's own text;
    // it cannot import a sibling config and compare the objects it produces.
    const config = (await import(
      pathToFileURL(join(repoRoot, dir, "vitest.config.ts")).href
    )) as { default: { test?: { include?: string[] } } };
    expect(config.default.test?.include).toBe(packageTests.test?.include);
  });
});
