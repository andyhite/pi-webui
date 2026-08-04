import { describe, expect, it } from "vitest";

import { hasSection, renderSection, withSection } from "./changelog.ts";

const PREAMBLE = `# Changelog

Prose explaining the file.
`;

const section = {
  version: "0.1.0",
  date: "2026-08-04",
  notes: "### Features\n\n- a (0000000a)",
};

describe("withSection", () => {
  it("replaces the Unreleased placeholder on the first release, exactly as it promises", () => {
    const before = `${PREAMBLE}
## Unreleased

No release yet. The first tag replaces this section with generated entries.
`;
    const after = withSection(before, section);
    expect(after).not.toContain("## Unreleased");
    expect(after).not.toContain("No release yet");
    expect(after).toContain("## v0.1.0 — 2026-08-04");
    expect(after.startsWith(PREAMBLE.trimEnd())).toBe(true);
  });

  it("puts a later release above the earlier ones and rewrites none of them", () => {
    const before = `${PREAMBLE}
## v0.1.0 — 2026-08-04

### Features

- a (0000000a)
`;
    const after = withSection(before, {
      version: "0.2.0",
      date: "2026-09-01",
      notes: "### Features\n\n- b (0000000b)",
    });
    expect(after.indexOf("## v0.2.0")).toBeLessThan(after.indexOf("## v0.1.0"));
    // The earlier section survives byte for byte: it is a record, not a draft.
    expect(after).toContain(
      "## v0.1.0 — 2026-08-04\n\n### Features\n\n- a (0000000a)",
    );
  });

  it("preserves the file's own prose, which is not generated", () => {
    const after = withSection(
      `${PREAMBLE}\n## Unreleased\n\nplaceholder\n`,
      section,
    );
    expect(after).toContain("Prose explaining the file.");
  });

  it("copes with a file that has no sections at all yet", () => {
    const after = withSection(PREAMBLE, section);
    expect(after).toContain("Prose explaining the file.");
    expect(after).toContain("## v0.1.0 — 2026-08-04");
    expect(after.trimEnd().endsWith("- a (0000000a)")).toBe(true);
  });

  it("leaves exactly one blank line between the preamble and the newest section", () => {
    const after = withSection(
      `${PREAMBLE}\n## Unreleased\n\nplaceholder\n`,
      section,
    );
    expect(after).toContain("Prose explaining the file.\n\n## v0.1.0");
  });
});

describe("hasSection", () => {
  it("recognises a version that has already been written", () => {
    const file = `${PREAMBLE}\n## v0.1.0 — 2026-08-04\n\nnotes\n`;
    expect(hasSection(file, "0.1.0")).toBe(true);
    expect(hasSection(file, "0.2.0")).toBe(false);
  });

  it("does not mistake 0.1.0 for 0.1.01, since the dots are not wildcards", () => {
    const file = `${PREAMBLE}\n## v0.1.10 — 2026-08-04\n\nnotes\n`;
    expect(hasSection(file, "0.1.1")).toBe(false);
    expect(hasSection(file, "0.1.10")).toBe(true);
  });
});

describe("renderSection", () => {
  it("titles a section with the tag it corresponds to", () => {
    expect(renderSection(section)).toBe(
      "## v0.1.0 — 2026-08-04\n\n### Features\n\n- a (0000000a)\n",
    );
  });
});
