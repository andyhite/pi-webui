import { Linter } from "eslint";
import { describe, expect, it } from "vitest";

import plugin from "../packages/config/eslint-config/plugin.js";

/**
 * Proves the two architectural rules actually fire (#307's verify item):
 * a deliberate violation fixture, run through the real rule the same way
 * `eslint.config.js` wires it, must be caught. `Linter.verify` is enough —
 * these rules only need an ES module parser, not full TypeScript type
 * information, so this skips standing up a package build just to exercise
 * them.
 */

const linter = new Linter();

function lint(code: string, ruleId: string) {
  return linter.verify(code, {
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    plugins: { plotroom: plugin },
    rules: { [`plotroom/${ruleId}`]: "error" },
  });
}

describe("plotroom/toolkit-encapsulation", () => {
  it("does not fire on a workspace-free module", () => {
    const messages = lint(
      `import { useState } from "react";\nexport const x = useState;\n`,
      "toolkit-encapsulation",
    );
    expect(messages).toEqual([]);
  });

  it("fires on a static import from another workspace package", () => {
    const messages = lint(
      `import { something } from "@plotroom/core";\n`,
      "toolkit-encapsulation",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.ruleId).toBe("plotroom/toolkit-encapsulation");
  });

  it("fires on a dynamic import from another workspace package", () => {
    const messages = lint(
      `export async function load() {\n  return import("@plotroom/plugin-sdk");\n}\n`,
      "toolkit-encapsulation",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.ruleId).toBe("plotroom/toolkit-encapsulation");
  });
});

describe("plotroom/renderer-no-node-import", () => {
  it("does not fire on browser-only code", () => {
    const messages = lint(
      `export function render() {\n  return document.createElement("div");\n}\n`,
      "renderer-no-node-import",
    );
    expect(messages).toEqual([]);
  });

  it("fires on a node: import", () => {
    const messages = lint(
      `import { readFileSync } from "node:fs";\nreadFileSync("x");\n`,
      "renderer-no-node-import",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.ruleId).toBe("plotroom/renderer-no-node-import");
  });

  it("fires on a bare Buffer global reference", () => {
    const messages = lint(
      `export const bytes = Buffer.from("x");\n`,
      "renderer-no-node-import",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.ruleId).toBe("plotroom/renderer-no-node-import");
  });

  it("fires on a bare process global reference", () => {
    const messages = lint(
      `export const cwd = process.cwd();\n`,
      "renderer-no-node-import",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.ruleId).toBe("plotroom/renderer-no-node-import");
  });

  it("does not fire on a locally declared process variable", () => {
    const messages = lint(
      `function handler(process) {\n  return process.cwd();\n}\n`,
      "renderer-no-node-import",
    );
    expect(messages).toEqual([]);
  });
});
