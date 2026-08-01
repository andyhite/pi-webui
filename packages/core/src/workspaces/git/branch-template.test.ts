import { describe, expect, it } from "vitest";

import {
  DEFAULT_BRANCH_TEMPLATE,
  checkRefName,
  renderBranchTemplate,
  resolveBranchName,
  slugify,
} from "./branch-template.js";

describe("renderBranchTemplate", () => {
  it("names a branch from ticket, type, and title (§3.4)", () => {
    const result = renderBranchTemplate(DEFAULT_BRANCH_TEMPLATE, {
      type: "feat",
      ticket: "OXY-2982",
      title: "Path claims for parallel sessions",
    });

    expect(result).toEqual({
      named: true,
      branch: "feat/oxy-2982-path-claims-for-parallel-sessions",
      shortened: false,
    });
  });

  it("is configurable — project and repository are tokens too", () => {
    const result = renderBranchTemplate("{project}/{repository}/{title}", {
      project: "PlotRoom",
      repository: "plotroom",
      title: "Git workspaces",
    });

    expect(result).toMatchObject({
      named: true,
      branch: "plotroom/plotroom/git-workspaces",
    });
  });

  it("collapses separators around values that are missing", () => {
    const result = renderBranchTemplate(DEFAULT_BRANCH_TEMPLATE, {
      type: "fix",
      ticket: null,
      title: "drift flags",
    });

    expect(result).toMatchObject({ named: true, branch: "fix/drift-flags" });
  });

  it("refuses a template token that does not exist", () => {
    expect(
      renderBranchTemplate("{author}/{title}", { title: "x" }),
    ).toMatchObject({ named: false, refusal: { reason: "unknown_token" } });
  });

  it("refuses when every value is empty rather than inventing a name", () => {
    expect(
      renderBranchTemplate(DEFAULT_BRANCH_TEMPLATE, {
        type: null,
        ticket: null,
        title: "",
      }),
    ).toMatchObject({ named: false, refusal: { reason: "empty_result" } });
  });

  it("says so when a long title was shortened to fit", () => {
    const result = renderBranchTemplate("{title}", {
      title: "a".repeat(200),
    });

    expect(result).toMatchObject({ named: true, shortened: true });
    if (!result.named) return;
    expect(result.branch).toHaveLength(48);
  });

  it("produces a valid ref name from hostile input", () => {
    const result = renderBranchTemplate("{title}", {
      title: "fix:  the ~thing~ [again]",
    });

    expect(result).toMatchObject({
      named: true,
      branch: "fix-the-thing-again",
    });
  });
});

describe("checkRefName", () => {
  it("accepts an ordinary branch name", () => {
    expect(checkRefName("feat/git-workspaces")).toEqual({ valid: true });
  });

  it.each([
    ["feat/with space"],
    ["feat/..dots"],
    ["feat/at@{here}"],
    ["/leading"],
    ["trailing/"],
    ["feat/x.lock"],
    ["@"],
    ["feat/.hidden"],
  ])("refuses %s", (name) => {
    expect(checkRefName(name)).toMatchObject({
      valid: false,
      refusal: { reason: "invalid_ref_name" },
    });
  });
});

describe("resolveBranchName", () => {
  it("never re-derives a branch that already exists (§3.4)", () => {
    const result = resolveBranchName(
      "someone-elses-branch",
      DEFAULT_BRANCH_TEMPLATE,
      {
        type: "feat",
        ticket: "OXY-1",
        title: "something else entirely",
      },
    );

    expect(result).toEqual({
      named: true,
      branch: "someone-elses-branch",
      derived: false,
      shortened: false,
    });
  });

  it("derives one only when there is none", () => {
    expect(
      resolveBranchName(null, DEFAULT_BRANCH_TEMPLATE, {
        type: "feat",
        ticket: "OXY-1",
        title: "Thing",
      }),
    ).toEqual({
      named: true,
      branch: "feat/oxy-1-thing",
      derived: true,
      shortened: false,
    });
  });

  it("refuses an existing branch that git itself would refuse", () => {
    expect(
      resolveBranchName("bad name", DEFAULT_BRANCH_TEMPLATE, {}),
    ).toMatchObject({ named: false, refusal: { reason: "invalid_ref_name" } });
  });
});

describe("slugify", () => {
  it("normalizes accents and punctuation", () => {
    expect(slugify("Café — déjà vu!", 64)).toBe("cafe-deja-vu");
  });

  it("does not leave a trailing separator when it shortens", () => {
    expect(slugify("aaaa bbbb cccc", 5)).toBe("aaaa");
  });
});
