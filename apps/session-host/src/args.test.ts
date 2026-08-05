import { describe, expect, it } from "bun:test";

import { parseSessionHostArgs, SessionHostArgsError } from "./args.js";

const MINIMUM = [
  "--cwd",
  "/workspaces/one",
  "--session-dir",
  "/state/runtime/session-host",
  "--model",
  "anthropic/claude-haiku-4-5",
  "--effort",
  "medium",
];

describe("parseSessionHostArgs", () => {
  it("reads what PlotRoom launched the session with", () => {
    expect(parseSessionHostArgs(MINIMUM)).toEqual({
      cwd: "/workspaces/one",
      sessionDir: "/state/runtime/session-host",
      model: "anthropic/claude-haiku-4-5",
      effort: "medium",
      toolNames: null,
      resume: null,
      through: null,
    });
  });

  it("keeps a narrowed tool set, and inherits the pinned one otherwise", () => {
    const narrowed = parseSessionHostArgs([
      ...MINIMUM,
      "--tools",
      "read, grep ,bash",
    ]);

    expect(narrowed.toolNames).toEqual(["read", "grep", "bash"]);
    expect(parseSessionHostArgs(MINIMUM).toolNames).toBe(null);
  });

  it("refuses rather than defaulting", () => {
    // Each of these would otherwise run work against something nobody chose: a
    // different workspace, a different model, or a different amount of thinking.
    expect(() => parseSessionHostArgs(MINIMUM.slice(2))).toThrow(
      SessionHostArgsError,
    );
    expect(() => parseSessionHostArgs([...MINIMUM, "--pretend"])).toThrow(
      "unknown session-host argument: --pretend",
    );
    expect(() => parseSessionHostArgs([...MINIMUM, "--tools"])).toThrow(
      "--tools needs a value",
    );
    expect(() => parseSessionHostArgs([...MINIMUM, "--tools", ""])).toThrow(
      "--tools was empty",
    );
  });

  it("refuses an effort PlotRoom does not have", () => {
    expect(() =>
      parseSessionHostArgs([...MINIMUM.slice(0, 7), "enthusiastic"]),
    ).toThrow("--effort must be one of");
  });

  it("addresses a resume by the session file", () => {
    expect(
      parseSessionHostArgs([...MINIMUM, "--resume", "/sessions/a.jsonl"])
        .resume,
    ).toBe("/sessions/a.jsonl");
  });

  it("reads a fork's turn, but only alongside a resume", () => {
    expect(
      parseSessionHostArgs([
        ...MINIMUM,
        "--resume",
        "/sessions/a.jsonl",
        "--through",
        "2",
      ]).through,
    ).toBe(2);

    expect(() => parseSessionHostArgs([...MINIMUM, "--through", "2"])).toThrow(
      "--through needs --resume",
    );

    expect(() =>
      parseSessionHostArgs([
        ...MINIMUM,
        "--resume",
        "/sessions/a.jsonl",
        "--through",
        "0",
      ]),
    ).toThrow('--through must be a positive integer, got "0"');
  });
});
