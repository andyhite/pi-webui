import { findNode, toJs } from "../lib/momoa-utils.js";

/**
 * The other half of the build tooling contract (#215): a package's tests are
 * excluded from its `build` project but still typechecked, through a
 * `tsconfig.tests.json` shaped exactly the same way everywhere. Applies to
 * both `tsconfig.json` (the exclude-tests half) and `tsconfig.tests.json`
 * (the tests-project half) — which file is which is read from the filename,
 * not an option, because the shape is not per-package: a package that needs
 * a different shape here is the graph-shaped exception this rule cannot
 * express, and belongs back in `scripts/workspace-tooling.test.ts`.
 */

const TESTS_EXCLUDE_PATTERN = "src/**/*.test.ts";
const EXPECTED_TESTS_EXTENDS = [
  "./tsconfig.json",
  "@plotroom/typescript-config/tests.json",
];
const EXPECTED_TESTS_INCLUDE = ["src/**/*"];

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "enforce the shared tsconfig.json / tsconfig.tests.json shape across workspace packages",
      recommended: true,
    },
    schema: [],
    messages: {
      missingTestsExclude:
        'tsconfig.json "exclude" must contain "{{pattern}}" so the build project never emits a test file.',
      badTestsExtends:
        'tsconfig.tests.json "extends" must be {{expected}}, got {{actual}}.',
      badTestsInclude:
        'tsconfig.tests.json "include" must be {{expected}}, got {{actual}}.',
      badTestsExclude:
        'tsconfig.tests.json "exclude" must be empty: it typechecks everything the build project left out.',
      badTsBuildInfoFile:
        'tsconfig.tests.json compilerOptions.tsBuildInfoFile must be "dist/.tsbuildinfo.tests", got {{actual}}.',
    },
  },
  create(context) {
    const isTestsProject = context.filename.endsWith("tsconfig.tests.json");

    return {
      Document(node) {
        const data = /** @type {Record<string, unknown>} */ (toJs(node));

        if (!isTestsProject) {
          const exclude = /** @type {Array<string>} */ (data.exclude ?? []);
          if (!exclude.includes(TESTS_EXCLUDE_PATTERN)) {
            context.report({
              node: findNode(node, ["exclude"]),
              messageId: "missingTestsExclude",
              data: { pattern: TESTS_EXCLUDE_PATTERN },
            });
          }
          return;
        }

        const extendsValue = data.extends;
        const extendsList = Array.isArray(extendsValue)
          ? extendsValue
          : typeof extendsValue === "string"
            ? [extendsValue]
            : [];
        if (
          extendsList.length !== EXPECTED_TESTS_EXTENDS.length ||
          extendsList.some((e, i) => e !== EXPECTED_TESTS_EXTENDS[i])
        ) {
          context.report({
            node: findNode(node, ["extends"]),
            messageId: "badTestsExtends",
            data: {
              expected: JSON.stringify(EXPECTED_TESTS_EXTENDS),
              actual: JSON.stringify(extendsValue ?? null),
            },
          });
        }

        const include = data.include;
        if (
          !Array.isArray(include) ||
          include.length !== EXPECTED_TESTS_INCLUDE.length ||
          include.some((v, i) => v !== EXPECTED_TESTS_INCLUDE[i])
        ) {
          context.report({
            node: findNode(node, ["include"]),
            messageId: "badTestsInclude",
            data: {
              expected: JSON.stringify(EXPECTED_TESTS_INCLUDE),
              actual: JSON.stringify(include ?? null),
            },
          });
        }

        const exclude = data.exclude;
        if (!Array.isArray(exclude) || exclude.length !== 0) {
          context.report({
            node: findNode(node, ["exclude"]),
            messageId: "badTestsExclude",
          });
        }

        const compilerOptions =
          /** @type {Record<string, unknown>} */ (data.compilerOptions) ?? {};
        if (compilerOptions.tsBuildInfoFile !== "dist/.tsbuildinfo.tests") {
          context.report({
            node: findNode(node, ["compilerOptions", "tsBuildInfoFile"]),
            messageId: "badTsBuildInfoFile",
            data: {
              actual: JSON.stringify(compilerOptions.tsBuildInfoFile ?? null),
            },
          });
        }
      },
    };
  },
};

export default rule;
