import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeScript } from "../runtime/scripted.js";
import { parseNameStatus, splitHunks } from "../workspaces/diff.js";
import {
  at,
  boot,
  cleanupHarnesses,
  command,
  endedSession,
  list,
  repository,
  run,
  str,
} from "../testing/harness.js";

/**
 * The workspace diff read (§11, §3.4).
 *
 * "A workspace's changes — file tree and patches, read-only." What is worth
 * testing is not that git can diff: it is that the endpoint tells the truth about
 * the states where there is nothing to diff, and that the shape it returns is the
 * one the Diff panel renders.
 */
afterEach(cleanupHarnesses);

const writesFile = (path: string, content: string): RuntimeScript => ({
  acts: [
    {
      on: "start",
      steps: [
        { observation: { kind: "turn-started", turn: 1 } },
        { effect: { kind: "write-file", path, content } },
        {
          observation: {
            kind: "turn-ended",
            turn: 1,
            usage: { inputTokens: 6, outputTokens: 2 },
          },
        },
        {
          observation: {
            kind: "session-ended",
            reason: { kind: "ended-by-user" },
          },
        },
      ],
    },
  ],
});

describe("GET /api/workstreams/:id/diff", () => {
  it("says a workstream has no workspace rather than reporting no changes", async () => {
    const harness = await boot(repository());
    const workstream = str(
      await harness.ok("/workstreams", { method: "POST", body: {} }),
      "workstream.id",
    );

    const diff = await harness.ok(`/workstreams/${workstream}/diff`);

    // "Not provisioned" and "no changes" are different facts, and the panel needs
    // to be able to tell them apart (§3.4's visible reason).
    expect(at(diff, "state")).toBe("no-workspace");
    expect(String(at(diff, "reason"))).toContain("first run provisions");
    expect(list(diff, "files")).toHaveLength(0);
    expect(at(diff, "base")).toBeNull();
  });

  it("404s for a workstream that does not exist", async () => {
    const harness = await boot(repository());
    const missing = await harness.call("/workstreams/ws_nope/diff");
    expect(missing.status).toBe(404);
  });

  it("reports an untracked file a session wrote, with a patch and hunks", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, { lifecycle: "open" });
    const sessionId = str(
      await run(
        harness,
        fixture.commandId,
        writesFile("src/added.ts", "export const one = 1;\n"),
      ),
      "session.id",
    );
    await endedSession(harness, sessionId);

    const diff = await harness.ok(`/workstreams/${fixture.workstream}/diff`);

    expect(at(diff, "state")).toBe("ready");
    // The base is stated, never left to be inferred: a diff whose base is a guess
    // is a wrong answer with no evidence (principle 7).
    expect(at(diff, "base.ref")).toBeTruthy();
    expect(String(at(diff, "base.description")).length).toBeGreaterThan(10);

    const files = list(diff, "files");
    const added = files.find((file) => at(file, "path") === "src/added.ts");
    expect(added).toBeDefined();
    expect(at(added, "status")).toBe("added");

    // Both shapes, so the panel renders whichever it wants (`packages/ui`'s own
    // note on `DiffFile`).
    expect(String(at(added, "patchText"))).toContain("export const one = 1;");
    expect(list(added, "hunks").length).toBeGreaterThan(0);
    expect(String(at(added, "hunks.0.header"))).toMatch(/^@@/);
  });
});

describe("git's own output, parsed", () => {
  it("spends three fields on a rename and two on everything else", () => {
    // `-z` output: NUL-separated, and a rename carries both paths. Parsed rather
    // than split on lines because a path may contain anything but NUL.
    const parsed = parseNameStatus(
      "M\0src/a.ts\0R100\0src/old.ts\0src/new.ts\0D\0src/gone.ts\0",
    );

    expect(parsed).toEqual([
      { path: "src/a.ts", status: "modified" },
      { path: "src/new.ts", status: "renamed", previousPath: "src/old.ts" },
      { path: "src/gone.ts", status: "deleted" },
    ]);
  });

  it("skips an unrecognized status without losing what follows it", () => {
    // A letter nobody taught this parser is skipped with its operands rather than
    // guessed at, so the rest of the list still means what it says (principle 7).
    const parsed = parseNameStatus("X\0src/weird.ts\0A\0src/new.ts\0");
    expect(parsed).toEqual([{ path: "src/new.ts", status: "added" }]);
  });

  it("splits a patch into hunks and leaves the preamble out of them", () => {
    const hunks = splitHunks(
      [
        "diff --git a/x b/x",
        "--- a/x",
        "+++ b/x",
        "@@ -1,2 +1,3 @@",
        " one",
        "+two",
        "@@ -10,1 +11,1 @@",
        "-old",
      ].join("\n"),
    );

    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.header).toBe("@@ -1,2 +1,3 @@");
    expect(hunks[0]?.lines).toEqual([" one", "+two"]);
    expect(hunks[1]?.lines).toEqual(["-old"]);
  });
});
