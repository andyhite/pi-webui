import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { packageTests } from "../vitest.base.config.ts";

/**
 * The build tooling contract every workspace package answers to (#215).
 *
 * `AGENTS.md` → "Layout" states it in prose — *"each has `build`, `typecheck`,
 * `lint`, and `test` scripts; Turborepo drives them from the root"* — and prose
 * is what let it drift: two packages ended up with no vitest configuration at
 * all (`packages/ui`, the largest suite here, ran on vitest's default include),
 * three typechecked no test at all, and three emitted their own tests into
 * `dist/`. Every one of those was invisible in a green `pnpm verify`, which is
 * the definition of a rule that is documented rather than enforced.
 *
 * So the contract is a test, and a deviation is a row in one of the tables below
 * with the reason it is not overlap. A new package fails here until it either
 * matches every other package or says in writing why it cannot.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const CANONICAL = {
  build: "tsc -b",
  typecheck: "tsc -b && tsc -p tsconfig.tests.json",
  lint: "eslint .",
  test: "vitest run",
  testsProjectInclude: ["src/**/*"],
  testsProjectExclude: [] as string[],
  buildExcludesTests: "src/**/*.test.ts",
};

/**
 * Packages whose own `dist/` is under test — their host suites load the built
 * plugin entry in a worker, which is exactly what the product loads — so `test`
 * builds first. Turbo's `test` task depends on `^build`, upstream only, and a
 * cold cache is where the difference showed (#118).
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

type Manifest = {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type TsConfig = {
  extends?: string | string[];
  include?: string[];
  exclude?: string[];
  compilerOptions?: Record<string, unknown>;
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

/** What `pnpm-workspace.yaml`'s `packages:` globs expand to on disk. */
function workspace(): { globs: string[]; entries: number; dirs: string[] } {
  // Only that block: the file carries other list-valued keys
  // (`onlyBuiltDependencies` and friends), and treating one of their entries as
  // a package glob would fail confusingly rather than wrongly.
  const all = read("pnpm-workspace.yaml").split("\n");
  const start = all.findIndex((line) => /^packages:/.test(line));
  if (start < 0) throw new Error("pnpm-workspace.yaml declares no packages");
  const lines: string[] = [];
  for (const line of all.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    if (/\S/.test(line)) lines.push(line);
  }
  const globs = lines.flatMap((line) => {
    // Quotes are optional in YAML, so the pattern cannot require them: a
    // silently unparsed line would drop a whole family of packages from every
    // assertion below, which `entries` is compared against for that reason.
    const match = /^\s*-\s*"?([^"\s]+)"?\s*$/.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  });
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
  return { globs, entries: lines.length, dirs: dirs.sort() };
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
  it("is every one pnpm's globs expand to", () => {
    // A glob this test failed to parse would make every assertion below vacuous
    // for that whole family of packages.
    expect(globs).toHaveLength(entries);
    expect(packages.map((p) => p.dir)).toContain("packages/core");
    expect(packages.map((p) => p.dir)).toContain("apps/session-host");
    for (const { dir, manifest } of packages) {
      expect(manifest.name, dir).toMatch(/^@plotroom\//);
    }
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
    // shape is a deliberate edit to both patterns, not a file somebody adds.
    const stray = packages.flatMap(({ dir }) =>
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
    const undeclared = packages
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

describe.each(packages)("$dir", ({ dir, manifest }) => {
  const scripts = manifest.scripts ?? {};
  const tsconfig = parseJsonc(read(`${dir}/tsconfig.json`)) as TsConfig;

  it("builds, typechecks and lints the same way as every other package", () => {
    // A package may append steps of its own — `vite build`, an asset copy, the
    // e2e project's typecheck — but never replace the shared ones.
    expect(scripts.build ?? "", "build").toMatch(
      new RegExp(`^${CANONICAL.build}( &&|$)`),
    );
    expect(scripts.typecheck ?? "", "typecheck").toMatch(
      new RegExp(`^${CANONICAL.typecheck.replaceAll(".", "\\.")}( &&|$)`),
    );
    expect(scripts.lint, "lint").toBe(CANONICAL.lint);
  });

  it("runs its tests with the shared runner and no --passWithNoTests", () => {
    const exception = NOT_VITEST[dir];
    const prefix = dir in BUILDS_ITS_OWN_DIST ? `${CANONICAL.build} && ` : "";
    expect(scripts.test, exception?.why ?? "test").toBe(
      exception ? exception.test : `${prefix}${CANONICAL.test}`,
    );
    // `--passWithNoTests` reports green when the include pattern matches
    // nothing, which is the failure that hid `packages/ui`'s missing config.
    expect(scripts.test ?? "").not.toContain("--passWithNoTests");
    expect(
      existsSync(join(repoRoot, dir, "vitest.config.ts")),
      exception ? "must not also configure vitest" : "needs a vitest config",
    ).toBe(exception === undefined);
  });

  it("keeps its tests out of the build and typechecks them anyway", () => {
    expect(tsconfig.exclude ?? [], "tsconfig.json exclude").toContain(
      CANONICAL.buildExcludesTests,
    );

    const tests = parseJsonc(read(`${dir}/tsconfig.tests.json`)) as TsConfig;
    const up = "../".repeat(dir.split("/").length).slice(0, -1);
    expect(tests.extends).toEqual([
      "./tsconfig.json",
      `${up}/tsconfig.tests.base.json`,
    ]);
    expect(tests.include).toEqual(CANONICAL.testsProjectInclude);
    expect(tests.exclude, "the tests project excludes nothing").toEqual(
      CANONICAL.testsProjectExclude,
    );
    expect(tests.compilerOptions?.tsBuildInfoFile).toBe(
      "dist/.tsbuildinfo.tests",
    );
  });

  if (!(dir in NOT_VITEST)) {
    it("takes its test include from the shared base, not a copy of it", async () => {
      // Runtime-selected specifier: one assertion over every package's config,
      // and the point is the object vitest really loads rather than its text.
      const config = (await import(
        pathToFileURL(join(repoRoot, dir, "vitest.config.ts")).href
      )) as { default: { test?: { include?: string[] } } };
      // Identity, not equality: `mergeConfig` keeps the base's array by
      // reference, so this passes for the three packages that add a timeout and
      // fails for a config that restates the pattern — which is the whole point
      // of the pattern living in one file.
      expect(config.default.test?.include).toBe(packageTests.test?.include);
    });
  }
});
