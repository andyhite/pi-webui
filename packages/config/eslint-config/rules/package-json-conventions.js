import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { findNode, toJs } from "../lib/momoa-utils.js";

/**
 * The build tooling contract every workspace package answers to (#215),
 * enforced directly on `package.json` instead of asserted from
 * `scripts/workspace-tooling.test.ts`. What is genuinely graph-shaped
 * (workspace-glob membership, cross-package uniqueness, a source file that
 * imports `node:` without the package declaring `@types/node`) stays in that
 * test — a lint rule visits one file at a time and cannot see the rest of
 * the workspace the way those checks need to.
 *
 * Options mirror the exception tables the test used to carry
 * (`BUILDS_ITS_OWN_DIST`, `NOT_VITEST`): a package that deviates says so in
 * its own `eslint.config.js` override, in writing, the same way the test
 * required a named row.
 *
 * @typedef {object} Options
 * @property {boolean} [buildsOwnDist] Host suites load this package's own
 *   `dist/`, so `test` runs `tsc -b && vitest run` instead of `vitest run`.
 * @property {string} [testOverride] A literal, non-vitest `test` script
 *   (Bun's session-host). Skips the vitest-config-existence check entirely.
 */

const CANONICAL_BUILD = /^tsc -b( &&|$)/;
const CANONICAL_TYPECHECK = /^tsc -b && tsc -p tsconfig\.tests\.json( &&|$)/;
const CANONICAL_LINT = "oxlint --type-aware";

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "enforce the workspace package.json contract (name scope, canonical scripts, declared shared-config devDependencies)",
      recommended: true,
    },
    schema: [
      {
        type: "object",
        properties: {
          buildsOwnDist: { type: "boolean" },
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
      passWithNoTests:
        '"test" must not use --passWithNoTests: it reports green when the include pattern matches nothing.',
      missingVitestConfig:
        "this package runs on the shared vitest runner and needs its own vitest.config.ts.",
      unexpectedVitestConfig:
        "this package overrides `test` away from the shared vitest runner and must not also configure vitest.",
      missingDevDependency:
        "{{dep}} is referenced by {{file}} but not declared as a devDependency.",
    },
  },
  create(context) {
    const options = /** @type {Options} */ (context.options[0] ?? {});
    const dir = dirname(context.filename);

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

        const checkScript = (script, pattern) => {
          const actual = scripts[script];
          if (typeof actual !== "string" || !pattern.test(actual)) {
            context.report({
              node: findNode(node, ["scripts", script]),
              messageId: "badScript",
              data: {
                script,
                expected: pattern.source,
                actual: JSON.stringify(actual ?? null),
              },
            });
          }
        };
        checkScript("build", CANONICAL_BUILD);
        checkScript("typecheck", CANONICAL_TYPECHECK);

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

        const expectedTest =
          options.testOverride ??
          (options.buildsOwnDist ? "tsc -b && vitest run" : "vitest run");
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
      },
    };
  },
};

export default rule;
