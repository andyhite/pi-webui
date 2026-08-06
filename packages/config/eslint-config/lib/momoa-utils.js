/**
 * Small helpers for writing @eslint/json rules against the Momoa AST without
 * re-deriving a hand-rolled object walker in every rule. `toJs` mirrors
 * `JSON.parse`'s output; `findNode` walks the same path back down the AST so
 * a rule can report at the location of the value it actually complained
 * about, not at the document root.
 */

/**
 * @param {import("@humanwhocodes/momoa").AnyNode} node
 * @returns {unknown}
 */
export function toJs(node) {
  switch (node.type) {
    case "Document":
      return toJs(node.body);
    case "Object": {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const member of node.members) {
        const key =
          member.name.type === "String" ? member.name.value : member.name.name;
        out[key] = toJs(member.value);
      }
      return out;
    }
    case "Array":
      return node.elements.map((element) => toJs(element.value));
    case "String":
    case "Number":
    case "Boolean":
      return node.value;
    case "Null":
      return null;
    default:
      return undefined;
  }
}

/**
 * Walks a Momoa AST following a plain-object key path (`["scripts", "test"]`)
 * and returns the node at that path, or the closest ancestor still on the
 * path if the leaf itself is missing — good enough to report a missing-field
 * error at the object that should have contained it.
 *
 * @param {import("@humanwhocodes/momoa").AnyNode} node
 * @param {Array<string>} path
 * @returns {import("@humanwhocodes/momoa").AnyNode}
 */
export function findNode(node, path) {
  let current = node.type === "Document" ? node.body : node;
  for (const key of path) {
    if (current.type !== "Object") return current;
    const member = current.members.find(
      (m) => (m.name.type === "String" ? m.name.value : m.name.name) === key,
    );
    if (!member) return current;
    current = member.value;
  }
  return current;
}
