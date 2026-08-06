/**
 * `@plotroom/toolkit` depends on nothing else in this workspace (#101): not
 * core, not a plugin, and not the plugin SDK, whose entry reaches the worker
 * host and would put Node in a package the renderer bundles. The toolkit
 * still has to agree with the SDK's frozen `Theme { tokens: Record<string,
 * string> }`; the compile-time proof that it does lives in
 * `packages/ui/src/theme/sdk-contract.ts` — the one package that can see
 * both types, exactly like `apps/server/src/plugins/raise.ts`. Drift on
 * either side is a build error, and the toolkit keeps zero workspace
 * dependencies.
 *
 * Ported as-is from the `no-restricted-imports` / `no-restricted-syntax`
 * pair in `packages/toolkit/eslint.config.js` (pre-#307) into one rule that
 * covers both the static and dynamic import forms in a single check.
 */

const MESSAGE =
  "@plotroom/toolkit depends on nothing in this workspace (#101). A type it needs from the plugin SDK is asserted in packages/ui/src/theme/sdk-contract.ts instead.";

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "disallow @plotroom/toolkit from importing any other workspace package, statically or dynamically",
      recommended: true,
    },
    schema: [],
    messages: {
      forbidden: MESSAGE,
    },
  },
  create(context) {
    /** @param {string | undefined} value */
    const isWorkspaceImport = (value) =>
      typeof value === "string" && /^@plotroom\//.test(value);

    return {
      ImportDeclaration(node) {
        if (isWorkspaceImport(node.source.value)) {
          context.report({ node: node.source, messageId: "forbidden" });
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source && isWorkspaceImport(node.source.value)) {
          context.report({ node: node.source, messageId: "forbidden" });
        }
      },
      ExportAllDeclaration(node) {
        if (isWorkspaceImport(node.source.value)) {
          context.report({ node: node.source, messageId: "forbidden" });
        }
      },
      ImportExpression(node) {
        if (
          node.source.type === "Literal" &&
          isWorkspaceImport(String(node.source.value))
        ) {
          context.report({ node: node.source, messageId: "forbidden" });
        }
      },
    };
  },
};

export default rule;
