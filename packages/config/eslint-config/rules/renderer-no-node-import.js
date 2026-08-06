/**
 * A plugin's renderer half runs in the browser (`@plotroom/ui`'s
 * `ContributionRegistry` calls these contributions in the page), so nothing
 * in this graph may reach for Node. It is not a style rule: importing a
 * plugin's host entry into the renderer once put `os.tmpdir()` in the
 * bundle, where it ran at module scope and killed the whole canvas before
 * React mounted. The host entry (`index.ts`) and everything only it reaches
 * is where the machine is allowed to be touched.
 *
 * Ported as-is from the `no-restricted-imports` / `no-restricted-globals`
 * pair duplicated across `packages/plugins/*\/eslint.config.js` (pre-#307)
 * into one rule, so the four copies of that override collapse into four
 * `files` lists pointing at the same check instead of four copies of the
 * check itself.
 */

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "disallow node: imports and Node-only globals in a plugin's renderer-reachable modules",
      recommended: true,
    },
    schema: [],
    messages: {
      noNodeImport:
        "a plugin's renderer contributions run in the browser: keep Node imports in the host entry (index.ts) and the modules it owns",
      noNodeGlobal:
        "no {{name}} in a renderer contribution (it does not exist in a browser tab){{suggestion}}",
    },
  },
  create(context) {
    const isNodeSpecifier = (value) =>
      typeof value === "string" && value.startsWith("node:");

    /** @param {import("estree").Node} node */
    const checkGlobal = (node) => {
      if (node.name === "Buffer") {
        context.report({
          node,
          messageId: "noNodeGlobal",
          data: {
            name: "Buffer",
            suggestion: " — use TextEncoder/TextDecoder",
          },
        });
      } else if (node.name === "process") {
        context.report({
          node,
          messageId: "noNodeGlobal",
          data: { name: "process", suggestion: "" },
        });
      }
    };

    return {
      ImportDeclaration(node) {
        if (isNodeSpecifier(node.source.value)) {
          context.report({ node: node.source, messageId: "noNodeImport" });
        }
      },
      ImportExpression(node) {
        if (
          node.source.type === "Literal" &&
          isNodeSpecifier(String(node.source.value))
        ) {
          context.report({ node: node.source, messageId: "noNodeImport" });
        }
      },
      "Identifier:exit"(node) {
        // Only bare global references, not `foo.Buffer` property access, an
        // object-literal/import-specifier key, or any occurrence — usage or
        // declaration site alike — of a locally declared/shadowing `process`
        // or `Buffer`.
        if (node.name !== "Buffer" && node.name !== "process") return;
        const parent = node.parent;
        if (
          parent &&
          parent.type === "MemberExpression" &&
          parent.property === node &&
          !parent.computed
        ) {
          return;
        }
        if (
          parent &&
          (parent.type === "Property" || parent.type === "ImportSpecifier") &&
          parent.key === node
        ) {
          return;
        }
        let scope = context.sourceCode.getScope(node);
        while (scope) {
          if (
            scope.variables.some(
              (variable) =>
                variable.name === node.name && variable.defs.length > 0,
            )
          ) {
            return;
          }
          scope = scope.upper;
        }
        checkGlobal(node);
      },
    };
  },
};

export default rule;
