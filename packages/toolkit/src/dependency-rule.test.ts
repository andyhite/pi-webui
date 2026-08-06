import path from "node:path";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * The dependency direction is a rule that refuses, not a convention (#101).
 *
 * `apps/web` → `@plotroom/ui` → `@plotroom/toolkit`, and the toolkit imports
 * nothing from this workspace: core would make the design system depend on the
 * domain, a plugin package would invert the contribution direction, and the
 * plugin SDK's entry reaches its worker host, which is how Node once ended up in
 * a renderer bundle.
 *
 * The rule lives in `packages/toolkit/eslint.config.js` (#306) — `packages/ui`
 * carries no such restriction, which is how it holds the SDK-contract
 * assertion. `pnpm lint` is the gate; this test is the proof it is wired:
 * without it, deleting the override would fail nothing.
 */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

/**
 * Lint a file that does not exist; the path only decides which config
 * applies. Each package carries its own `eslint.config.js` (#306), and flat
 * config resolves it from `cwd`, not from the linted file's directory — so
 * `cwd` has to be the file's own package, exactly like `pnpm --filter <pkg>
 * lint` runs it.
 */
async function lintAs(
  packageDir: string,
  relativePath: string,
  code: string,
): Promise<ESLint.LintResult[]> {
  const cwd = path.join(REPO_ROOT, packageDir);
  const eslint = new ESLint({ cwd });
  return eslint.lintText(code, {
    filePath: path.join(cwd, relativePath),
    warnIgnored: false,
  });
}

function messagesFrom(results: ESLint.LintResult[]): string[] {
  return results.flatMap((result) =>
    result.messages.map((message) => `${message.ruleId}: ${message.message}`),
  );
}

describe("the toolkit's dependency rule", () => {
  it.each([
    ["@plotroom/core", 'import { nothing } from "@plotroom/core";\n'],
    [
      "@plotroom/plugin-sdk",
      'import type { Theme } from "@plotroom/plugin-sdk";\nexport type T = Theme;\n',
    ],
    ["a plugin package", 'import { nothing } from "@plotroom/plugin-jira";\n'],
    ["a subpath", 'import { nothing } from "@plotroom/core/graph.js";\n'],
    ["a re-export", 'export { nothing } from "@plotroom/core";\n'],
    // `no-restricted-imports` never visits this form, so it is refused by the
    // `no-restricted-syntax` half of the rule. Both halves are the rule.
    [
      "a dynamic import",
      'export const load = async () => import("@plotroom/core");\n',
    ],
  ])("refuses an import of %s", async (_label, code) => {
    const messages = messagesFrom(
      await lintAs("packages/toolkit", "src/violation.ts", code),
    );
    expect(
      messages.filter(
        (message) =>
          message.startsWith("no-restricted-imports") ||
          message.startsWith("no-restricted-syntax"),
      ),
    ).toHaveLength(1);
  });

  it("leaves the toolkit's own relative imports alone", async () => {
    const messages = messagesFrom(
      await lintAs(
        "packages/toolkit",
        "src/allowed.ts",
        'import { DESIGN_TOKENS } from "./tokens.js";\nexport const count = DESIGN_TOKENS.length;\n',
      ),
    );
    expect(messages).toEqual([]);
  });

  /**
   * The rule is scoped to the toolkit, not global: `@plotroom/ui` is where the
   * SDK assertion lives and it must stay able to import both sides.
   */
  it("does not restrict the package that holds the SDK assertion", async () => {
    const messages = messagesFrom(
      await lintAs(
        "packages/ui",
        "src/theme/probe.ts",
        'import type { Theme } from "@plotroom/plugin-sdk";\nexport type T = Theme;\n',
      ),
    );
    expect(
      messages.filter((message) => message.startsWith("no-restricted-imports")),
    ).toEqual([]);
  });
});
