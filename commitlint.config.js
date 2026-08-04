/** @type {import("@commitlint/types").UserConfig} */
export default {
  extends: ["@commitlint/config-conventional"],
  // One commit already on `main` breaks `header-max-length` by a single
  // character: `a3e36474`, whose subject is 73. It cannot be fixed — history on
  // `main` is never rewritten (`AGENTS.md` → "Git rules") — and it is not
  // harmless to leave unlisted, because `pnpm release` refuses any range
  // containing a commit commitlint rejects (decision 0003), which is every
  // range reaching the first release. So the exception is recorded here, in the
  // file that decides what a message may be, rather than as a flag on the
  // release script that would weaken the gate for every range it ever reads.
  //
  // Matched on the header **exactly**, because `ignores` short-circuits the
  // entire lint for a message it matches: a prefix test would have exempted
  // any future commit merely *beginning* with this subject from every rule at
  // once — length, case, full stop and all — in the hook, in CI, and in the
  // release gate.
  ignores: [
    (message) =>
      message.split("\n", 1)[0] ===
      "docs: tick sync 1 checkboxes for epics 1.0, 1.3, 3.1, and the plugin host",
  ],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "docs",
        "refactor",
        "perf",
        "test",
        "build",
        "ci",
        "chore",
        "style",
        "revert",
      ],
    ],
    "scope-case": [2, "always", "kebab-case"],
    "subject-case": [2, "always", "lower-case"],
    "subject-full-stop": [2, "never", "."],
    "header-max-length": [2, "always", 72],
    "body-max-line-length": [2, "always", 100],
  },
};
