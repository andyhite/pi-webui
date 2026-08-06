import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

function findWorkspaceRoot(from) {
  let dir = from;
  for (;;) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const manifest = JSON.parse(readFileSync(candidate, "utf8"));
        if (Array.isArray(manifest.workspaces)) return dir;
      } catch {
        // not JSON we can parse (e.g. a jsonc tsconfig neighbor) -- keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return from;
    dir = parent;
  }
}

import { findNode, toJs } from "../lib/momoa-utils.js";

/**
 * The build tooling contract every workspace package answers to (#215, then
 * #315's no-build restructure), enforced directly on `package.json` instead
 * of asserted from `scripts/workspace-tooling.test.ts`. What is genuinely
 * graph-shaped (workspace-glob membership, cross-package uniqueness, a
 * source file that imports `node:` without the package declaring
 * `@types/node`) stays in that test — a lint rule visits one file at a time
 * and cannot see the rest of the workspace the way those checks need to.
 *
 * #315: no package builds a `dist/` anymore except the four real artifact
 * producers (`apps/web`, `packages/toolkit`, `apps/session-host`'s
 * `compile`, `apps/desktop`, until #316). Every workspace package's
 * `exports` map to its `src/*.ts` directly (raw-TS, Bun's bundler-style
 * resolution), and `typecheck` is a single root-scoped task
 * (`//#typecheck`, `turbo.json`) — no package carries its own `typecheck`
 * script anymore. `buildsOwnDist` is retired with the build it named: a
 * host suite that loads its own package's compiled entry (git/github/jira)
 * now loads `src/` directly, the same specifier the product resolves, and
 * needs a real Bun worker to do it (`testOverride`, same as `NOT_VITEST`
 * always required for a Bun-only suite).
 *
 * @typedef {object} Options
 * @property {string} [testOverride] A literal, non-vitest `test` script
 *   (Bun's `bun:test`). Skips the vitest-config-existence check entirely.
 */

const CANONICAL_LINT = "oxlint --type-aware";
/** Packages that may still declare a real `build` script (#315 point 6). */
const BUILD_ALLOWED = new Set([
  "apps/web",
  "apps/desktop",
  "apps/session-host",
  "packages/toolkit",
]);

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "enforce the workspace package.json contract (name scope, canonical scripts, no-build exports, declared shared-config devDependencies)",
      recommended: true,
    },
    schema: [
      {
        type: "object",
        properties: {
          testOverride: { type: "string" },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      badName:
        'package.json "name" must match /^@plotroom\\//, got "{{name}}".',
      badScript:
        '"{{script}}" must be "{{expected}}" (or start with it, followed by " && "), got {{actual}}.',
      unexpectedScript:
        '"{{script}}" is retired (#315): {{reason}}. Remove it from this package.json.',
      unexpectedBuildScript:
        '"build" is only allowed on {{allowed}} (#315: every other package is no-build, raw-TS exports). Remove it here.',
      passWithNoTests:
        '"test" must not use --passWithNoTests: it reports green when the include pattern matches nothing.',
      missingVitestConfig:
        "this package runs on the shared vitest runner and needs its own vitest.config.ts.",
      unexpectedVitestConfig:
        "this package overrides `test` away from the shared vitest runner and must not also configure vitest.",
      missingDevDependency:
        "{{dep}} is referenced by {{file}} but not declared as a devDependency.",
      badExportTarget:
        'exports["{{key}}"] must be a single "./src/*.ts" string target (#315: no build, no source/types/default split), got {{actual}}.',
      staleDistField:
        '"{{field}}" points at a build artifact that no longer exists (#315: no build). Remove it.',
    },
  },
  create(context) {
    const options = /** @type {Options} */ (context.options[0] ?? {});
    const dir = dirname(context.filename);
    const repoRoot = findWorkspaceRoot(dir);
    const repoRelativeDir = relative(repoRoot, dir).split("\\").join("/");
    const isLibraryPackage =
      /^packages\//.test(repoRelativeDir) &&
      !/^packages\/config\//.test(repoRelativeDir);

    return {
      Document(node) {
        const data = /** @type {Record<string, unknown>} */ (toJs(node));
        const scripts = /** @type {Record<string, string>} */ (
          data.scripts ?? {}
        );
        const deps = {
          .../** @type {object} */ (data.dependencies ?? {}),
          .../** @type {object} */ (data.devDependencies ?? {}),
        };

        const name = /** @type {string | undefined} */ (data.name);
        if (typeof name !== "string" || !/^@plotroom\//.test(name)) {
          context.report({
            node: findNode(node, ["name"]),
            messageId: "badName",
            data: { name: String(name) },
          });
        }

        if ("typecheck" in scripts) {
          context.report({
            node: findNode(node, ["scripts", "typecheck"]),
            messageId: "unexpectedScript",
            data: {
              script: "typecheck",
              reason:
                "the workspace has one root TypeScript 7 native check now (`bun run typecheck`, `//#typecheck` in turbo.json)",
            },
          });
        }

        if ("build" in scripts && !BUILD_ALLOWED.has(repoRelativeDir)) {
          context.report({
            node: findNode(node, ["scripts", "build"]),
            messageId: "unexpectedBuildScript",
            data: { allowed: [...BUILD_ALLOWED].join(", ") },
          });
        }

        if (scripts.lint !== CANONICAL_LINT) {
          context.report({
            node: findNode(node, ["scripts", "lint"]),
            messageId: "badScript",
            data: {
              script: "lint",
              expected: CANONICAL_LINT,
              actual: JSON.stringify(scripts.lint ?? null),
            },
          });
        }

        const expectedTest = options.testOverride ?? "vitest run";
        if (scripts.test !== expectedTest) {
          context.report({
            node: findNode(node, ["scripts", "test"]),
            messageId: "badScript",
            data: {
              script: "test",
              expected: expectedTest,
              actual: JSON.stringify(scripts.test ?? null),
            },
          });
        }
        if (scripts.test?.includes("--passWithNoTests")) {
          context.report({
            node: findNode(node, ["scripts", "test"]),
            messageId: "passWithNoTests",
          });
        }

        const vitestConfigExists = existsSync(join(dir, "vitest.config.ts"));
        if (options.testOverride === undefined && !vitestConfigExists) {
          context.report({
            node: findNode(node, ["scripts", "test"]),
            messageId: "missingVitestConfig",
          });
        }
        if (options.testOverride !== undefined && vitestConfigExists) {
          context.report({
            node: findNode(node, ["scripts", "test"]),
            messageId: "unexpectedVitestConfig",
          });
        }

        const eslintConfigPath = join(dir, "eslint.config.js");
        if (
          existsSync(eslintConfigPath) &&
          readFileSync(eslintConfigPath, "utf8").includes(
            "@plotroom/eslint-config",
          ) &&
          !("@plotroom/eslint-config" in deps)
        ) {
          context.report({
            node: findNode(node, ["devDependencies"]),
            messageId: "missingDevDependency",
            data: { dep: "@plotroom/eslint-config", file: "eslint.config.js" },
          });
        }

        const tsconfigPath = join(dir, "tsconfig.json");
        if (
          existsSync(tsconfigPath) &&
          readFileSync(tsconfigPath, "utf8").includes(
            "@plotroom/typescript-config",
          ) &&
          !("@plotroom/typescript-config" in deps)
        ) {
          context.report({
            node: findNode(node, ["devDependencies"]),
            messageId: "missingDevDependency",
            data: {
              dep: "@plotroom/typescript-config",
              file: "tsconfig.json",
            },
          });
        }

        if (isLibraryPackage) {
          if ("main" in data) {
            context.report({
              node: findNode(node, ["main"]),
              messageId: "staleDistField",
              data: { field: "main" },
            });
          }
          if ("types" in data) {
            context.report({
              node: findNode(node, ["types"]),
              messageId: "staleDistField",
              data: { field: "types" },
            });
          }
          const exportsMap =
            /** @type {Record<string, unknown> | undefined} */ (data.exports);
          if (exportsMap && typeof exportsMap === "object") {
            for (const [key, target] of Object.entries(exportsMap)) {
              const isSingleTsTarget =
                typeof target === "string" && /\.ts$/.test(target);
              // `./toolkit.css`-style non-JS asset re-exports stay real dist
              // paths: nothing raw-TS to point them at.
              const isAssetTarget =
                typeof target === "string" && !/\.tsx?$/.test(target);
              if (!isSingleTsTarget && !isAssetTarget) {
                context.report({
                  node: findNode(node, ["exports", key]),
                  messageId: "badExportTarget",
                  data: { key, actual: JSON.stringify(target) },
                });
              }
            }
          }
        }
      },
    };
  },
};

export default rule;
