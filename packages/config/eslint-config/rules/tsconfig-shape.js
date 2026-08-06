import { findNode, toJs } from "../lib/momoa-utils.js";

/**
 * The tsconfig half of the build tooling contract (#215), restructured by
 * #315: there is no more build/tests project split (nothing emits, so
 * nothing needs a test file excluded from what it emits), and no more
 * per-package `typecheck` — the one root TypeScript 7 native check covers
 * every package's sources, tests included, directly. What is left for a
 * per-package `tsconfig.json` to get right is much smaller: extend the
 * shared base, and include its own `src/`.
 */

const EXPECTED_EXTENDS = "@plotroom/typescript-config/base.json";
const EXPECTED_INCLUDE = ["src/**/*"];

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "enforce the shared tsconfig.json shape across workspace packages (#315: single no-emit project, no per-package build/tests split)",
      recommended: true,
    },
    schema: [],
    messages: {
      badExtends:
        'tsconfig.json "extends" must be "{{expected}}", got {{actual}}.',
      badInclude:
        'tsconfig.json "include" must start with {{expected}}, got {{actual}}.',
      staleEmitOption:
        "tsconfig.json compilerOptions.{{option}} is a build-era leftover (#315: the workspace is noEmit everywhere except apps/desktop's own tsconfig.build.json). Remove it.",
    },
  },
  create(context) {
    return {
      Document(node) {
        const data = /** @type {Record<string, unknown>} */ (toJs(node));

        const extendsValue = data.extends;
        if (extendsValue !== EXPECTED_EXTENDS) {
          context.report({
            node: findNode(node, ["extends"]),
            messageId: "badExtends",
            data: {
              expected: EXPECTED_EXTENDS,
              actual: JSON.stringify(extendsValue ?? null),
            },
          });
        }

        const include = data.include;
        const includeOk =
          Array.isArray(include) &&
          EXPECTED_INCLUDE.every((v, i) => include[i] === v);
        if (!includeOk) {
          context.report({
            node: findNode(node, ["include"]),
            messageId: "badInclude",
            data: {
              expected: JSON.stringify(EXPECTED_INCLUDE),
              actual: JSON.stringify(include ?? null),
            },
          });
        }

        const compilerOptions =
          /** @type {Record<string, unknown>} */ (data.compilerOptions) ?? {};
        for (const option of [
          "composite",
          "declaration",
          "declarationMap",
          "rootDir",
          "outDir",
          "tsBuildInfoFile",
        ]) {
          if (option in compilerOptions) {
            context.report({
              node: findNode(node, ["compilerOptions", option]),
              messageId: "staleEmitOption",
              data: { option },
            });
          }
        }
      },
    };
  },
};

export default rule;
