import { describe, expect, it } from "bun:test";

import {
  checkRemoteUrl,
  parseGitConfig,
  resolveBranchName,
  slugify,
} from "./config.js";
import {
  findCredentialMaterial,
  hostGitEnv,
  isHostAuthFailure,
  redact,
  type CommandResult,
  type GitContext,
  type ShellCommand,
} from "./exec.js";
import { createGitWorkspaceKind } from "./kind.js";
import { createGitPlugin } from "./plugin.js";
import {
  parseCommitLog,
  parseGitScope,
  parseNameStatus,
  readBranches,
} from "./reads.js";
import { cap, createGitContentRenderer } from "./renderers.js";
import { parsePorcelainV2 } from "./status.js";
import { createGitTools } from "./tools.js";

/**
 * The git port's hermetic tests: pure parsing, and the mechanics driven by a
 * recorded fake so a refusal is proved rather than described. The real worker host
 * against real git is `host.integration.test.ts`.
 */

type Scripted = (command: ShellCommand) => CommandResult;

const contextOf = (script: Scripted): GitContext => ({
  exec: (command) => Promise.resolve(script(command)),
  hostEnvironment: { PATH: "/usr/bin", HOME: "/home/tester" },
});

const ok = (stdout = ""): CommandResult => ({
  exitCode: 0,
  stdout,
  stderr: "",
});
const fail = (stderr: string, exitCode = 128): CommandResult => ({
  exitCode,
  stdout: "",
  stderr,
});

const call = {
  invocationId: "test#1",
  actor: null,
  credentials: {},
  grants: [],
  log: () => undefined,
};

describe("configuration the kind validates itself (§3.4, §10.1)", () => {
  it("refuses an incomplete configuration with the fields that were wrong", () => {
    const parsed = parseGitConfig({});
    expect(parsed.valid).toBe(false);
    if (parsed.valid) {
      throw new Error("expected a refusal");
    }
    expect(parsed.refusal.fields).toEqual([
      "workspacePath",
      "repositoryPath",
      "remoteUrl",
    ]);
  });

  it("refuses a remote URL that carries a credential, inbound (§3.4)", () => {
    const parsed = parseGitConfig({
      workspacePath: "/w",
      remoteUrl: "https://x-access-token:ghp_secret@github.com/acme/app.git",
      strategy: "clone",
    });
    expect(parsed.valid).toBe(false);
    if (parsed.valid) {
      throw new Error("expected a refusal");
    }
    expect(parsed.refusal.fields).toEqual(["remoteUrl"]);
    // The message never echoes the secret back into a log (§8).
    expect(parsed.refusal.message).not.toContain("ghp_secret");
  });

  it("keeps an ssh remote legal: a user name is not a secret", () => {
    expect(checkRemoteUrl("git@github.com:acme/app.git").allowed).toBe(true);
    expect(checkRemoteUrl("ssh://git@host/acme/app.git").allowed).toBe(true);
    expect(checkRemoteUrl("https://token@host/acme/app.git").allowed).toBe(
      false,
    );
  });

  it("takes a configured branch as it is and never re-derives it (§3.4)", () => {
    const configured = parseGitConfig({
      workspacePath: "/w",
      repositoryPath: "/r",
      branch: "feat/OXY-2982-existing",
      branchInputs: { ticket: "OXY-1" },
    });
    if (!configured.valid) {
      throw new Error(configured.refusal.message);
    }
    expect(resolveBranchName(configured.config, "wsp_1")).toBe(
      "feat/OXY-2982-existing",
    );
  });

  it("names a new branch from the template, and from the workspace when nothing answers", () => {
    const templated = parseGitConfig({
      workspacePath: "/w",
      repositoryPath: "/r",
      branchTemplate: "plotroom/{ticket|title}",
      branchInputs: { ticket: null, title: "Fix the login flow" },
    });
    if (!templated.valid) {
      throw new Error(templated.refusal.message);
    }
    expect(resolveBranchName(templated.config, "wsp_1")).toBe(
      "plotroom/fix-the-login-flow",
    );

    // A placeholder nothing answers abandons the template rather than producing
    // a branch named after nothing that every workspace collides on.
    const unanswered = parseGitConfig({
      workspacePath: "/w",
      repositoryPath: "/r",
      branchTemplate: "{project}/{ticket}",
      branchInputs: { ticket: "OXY-1" },
    });
    if (!unanswered.valid) {
      throw new Error(unanswered.refusal.message);
    }
    expect(resolveBranchName(unanswered.config, "wsp_9")).toBe(
      "plotroom/wsp-9",
    );

    const empty = parseGitConfig({ workspacePath: "/w", repositoryPath: "/r" });
    if (!empty.valid) {
      throw new Error(empty.refusal.message);
    }
    expect(resolveBranchName(empty.config, "wsp_abc")).toBe("plotroom/wsp-abc");
    expect(slugify("OXY-2982: Fix It!")).toBe("oxy-2982-fix-it");
  });
});

describe("the host-auth invariant, ported (§3.4, §9.3)", () => {
  it("builds the child environment from an allowlist, so a token cannot ride along", () => {
    const env = hostGitEnv({
      PATH: "/usr/bin",
      HOME: "/home/tester",
      GITHUB_TOKEN: "ghp_secret",
      GIT_ASKPASS: "/tmp/askpass",
      GIT_CONFIG_COUNT: "1",
    });
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["GITHUB_TOKEN"]).toBeUndefined();
    expect(env["GIT_ASKPASS"]).toBeUndefined();
    expect(env["GIT_CONFIG_COUNT"]).toBeUndefined();
    // No interactive fallback: git fails with its own reason instead of hanging.
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
  });

  it("declares no credential permission at all", () => {
    const manifest = createGitPlugin({
      git: contextOf(() => ok()),
      clock: () => 0,
      scratchDirectory: "/tmp",
    });
    expect(
      manifest.permissions.map((request) => request.scope.kind).sort(),
    ).toEqual(["filesystem", "network"]);
  });

  it("recognizes a credential written into a provisioned workspace's own config", () => {
    const findings = findCredentialMaterial(
      [
        "core.bare=false",
        "url=https://x-access-token:ghp_secret@github.com/acme/app.git",
        "credential.helper=store",
      ].join("\n"),
    );
    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.line).join(" ")).not.toContain(
      "ghp_secret",
    );
    expect(redact("https://user:pass@host/x")).toBe("https://***@host/x");
  });

  it("classifies git's own authentication failure as host_auth, not as a mechanism bug", async () => {
    const kind = createGitWorkspaceKind(
      {
        git: contextOf((command) =>
          command.args[0] === "worktree"
            ? fail("Permission denied (publickey).")
            : command.args.includes("ls-remote")
              ? fail("Permission denied (publickey).")
              : fail("not found", 1),
        ),
        clock: () => 1,
        scratchDirectory: "/tmp",
      },
      [],
    );
    const outcome = await kind.provision(
      {
        workspaceId: "wsp_1" as never,
        workstreamId: "wst_1" as never,
        config: { workspacePath: "/w", repositoryPath: "/r" },
        requestedAt: 1,
      },
      call,
    );
    expect(outcome.provisioned).toBe(false);
    if (outcome.provisioned) {
      throw new Error("expected a failure");
    }
    expect(outcome.failure.reason).toBe("host_auth");
    expect(
      isHostAuthFailure({
        exitCode: 1,
        stdout: "",
        stderr: "fatal: Authentication failed for 'https://host/x'",
        args: [],
        cwd: "/w",
      }),
    ).toBe(true);
  });
});

describe("removal protections refuse rather than warn (§3.4)", () => {
  const statusOutput = (branch: string, dirty: boolean): string =>
    [
      "# branch.oid abc123",
      `# branch.head ${branch}`,
      ...(dirty ? ["1 .M N... 100644 100644 100644 aaa bbb src/app.ts"] : []),
    ].join("\0");

  const kindFor = (branch: string, dirty: boolean, worktree: boolean) =>
    createGitWorkspaceKind(
      {
        git: contextOf((command) => {
          const args = command.args;
          if (args[0] === "status") {
            return ok(statusOutput(branch, dirty));
          }
          if (args[0] === "rev-parse" && args.includes("--git-dir")) {
            return ok(worktree ? "/r/.git/worktrees/w\n" : "/w/.git\n");
          }
          if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
            return ok(worktree ? "/r/.git\n" : "/w/.git\n");
          }
          if (args[0] === "symbolic-ref") {
            return ok("origin/main\n");
          }
          if (args[0] === "config") {
            return ok("main\n");
          }
          if (args[0] === "worktree") {
            return ok();
          }
          return fail("unexpected");
        }),
        clock: () => 1,
        scratchDirectory: "/tmp",
      },
      [],
    );

  const workspace = {
    workspaceId: "wsp_1" as never,
    roots: [{ rootKey: "root", path: "/w" }],
    config: { workspacePath: "/w", repositoryPath: "/r" },
  };

  it("never removes the default branch, and force does not get past it", async () => {
    for (const force of [false, true]) {
      const outcome = await kindFor("main", false, true).remove(
        workspace,
        { force },
        call,
      );
      expect(outcome.removed).toBe(false);
      if (outcome.removed) {
        throw new Error("expected a refusal");
      }
      expect(outcome.refusal.forcible).toBe(false);
      expect(outcome.refusal.message).toContain("default branch");
    }
  });

  it("refuses uncommitted work, and says force would get past it", async () => {
    const refused = await kindFor("feat/x", true, true).remove(
      workspace,
      { force: false },
      call,
    );
    if (refused.removed) {
      throw new Error("expected a refusal");
    }
    expect(refused.refusal.forcible).toBe(true);

    const forced = await kindFor("feat/x", true, true).remove(
      workspace,
      { force: true },
      call,
    );
    expect(forced.removed).toBe(true);
  });

  it("refuses a checkout it cannot show it provisioned (the primary checkout, §3.4)", async () => {
    const outcome = await kindFor("feat/x", false, false).remove(
      workspace,
      { force: true },
      call,
    );
    expect(outcome.removed).toBe(false);
    if (outcome.removed) {
      throw new Error("expected a refusal");
    }
    expect(outcome.refusal.forcible).toBe(false);
    expect(outcome.refusal.message).toContain("primary checkout");
  });

  it("reports an unreadable checkout as unreadable, never as clean", async () => {
    const kind = createGitWorkspaceKind(
      {
        git: contextOf(() => fail("fatal: not a git repository")),
        clock: () => 5,
        scratchDirectory: "/tmp",
      },
      [],
    );
    const fingerprint = await kind.fingerprint(workspace, call);
    expect(fingerprint.units[0]?.unreadable).toContain("not a git repository");
    const status = await kind.status(workspace, call);
    expect(status.unavailable).toContain("not a git repository");
    expect(status.readiness).toBe("provision-failed");
  });
});

describe("reads: the scope carries the checkout, because nothing else can", () => {
  it("refuses a scope with no path rather than defaulting to somewhere", () => {
    expect(parseGitScope(null).ok).toBe(false);
    expect(parseGitScope("limit=3").ok).toBe(false);
    expect(parseGitScope("what=3").ok).toBe(false);
    expect(parseGitScope("path=/r limit=zero").ok).toBe(false);
  });

  it("reads path, base and a capped limit", () => {
    const parsed = parseGitScope("path=/repos/app base=main limit=9999");
    if (!parsed.ok) {
      throw new Error(parsed.why);
    }
    expect(parsed.scope).toEqual({
      path: "/repos/app",
      baseRef: "main",
      limit: 200,
    });
    const bare = parseGitScope("/repos/app");
    if (!bare.ok) {
      throw new Error(bare.why);
    }
    expect(bare.scope.path).toBe("/repos/app");
  });

  it("parses porcelain v2, including renames and untracked files", () => {
    const read = parsePorcelainV2(
      [
        "# branch.oid deadbeef",
        "# branch.head feat/x",
        "# branch.upstream origin/feat/x",
        "# branch.ab +2 -1",
        "1 .M N... 100644 100644 100644 aaa bbb src/app.ts",
        "2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts",
        "src/old.ts",
        "? notes.md",
        "! dist/bundle.js",
      ].join("\0"),
    );
    expect(read.branch).toBe("feat/x");
    expect(read.ahead).toBe(2);
    expect(read.behind).toBe(1);
    expect(read.entries.map((entry) => entry.path)).toEqual([
      "src/app.ts",
      "src/new.ts",
      "notes.md",
      "dist/bundle.js",
    ]);
    expect(read.entries[1]?.origPath).toBe("src/old.ts");
  });

  it("parses a rename's three fields in --name-status -z", () => {
    expect(parseNameStatus("R100\0old.ts\0new.ts\0M\0src/app.ts\0")).toEqual([
      { path: "new.ts", status: "renamed", previousPath: "old.ts" },
      { path: "src/app.ts", status: "modified", previousPath: null },
    ]);
  });

  it("parses a commit log with its touched paths", () => {
    const commits = parseCommitLog(
      [
        "\x1eabc\x1fabc1234\x1fA <a@b>\x1f2024-01-01T00:00:00Z\x1fdo the thing\x1fwhy",
        "\0\nsrc/app.ts\0src/other.ts\0",
      ].join(""),
    );
    expect(commits).toHaveLength(1);
    expect(commits[0]?.subject).toBe("do the thing");
    expect(commits[0]?.files).toEqual(["src/app.ts", "src/other.ts"]);
  });

  it("reports a branch read git could not answer, rather than an empty list", async () => {
    const read = await readBranches(
      contextOf(() => fail("fatal: not a git repository")),
      "/nowhere",
    );
    expect(read.read).toBe(false);
  });
});

describe("renderers report truncation rather than performing it silently (principle 12)", () => {
  it("caps agent content and says how much it dropped", () => {
    const long = "x".repeat(200 * 1024);
    const capped = cap(long, "too long");
    expect(capped.truncated).not.toBeNull();
    expect(capped.truncated?.omittedBytes).toBe(
      200 * 1024 - capped.content.length,
    );
    expect(cap("short", "why").truncated).toBeNull();
  });

  it("renders a diff delta as what changed, not as new state", () => {
    const renderer = createGitContentRenderer();
    const previous = {
      kind: "diff" as const,
      externalId: "git:diff:/w",
      title: "1 file changed in /w",
      renderings: {
        card: "",
        summary: "",
        agentContent: "- modified: src/app.ts",
      },
    };
    const next = {
      ...previous,
      renderings: {
        card: "",
        summary: "",
        agentContent: "- modified: src/app.ts\n- added: src/new.ts",
      },
    };
    const delta = renderer.renderDelta(previous, next, call);
    expect("content" in delta ? delta.content : "").toContain(
      "Newly changed: src/new.ts",
    );
  });
});

describe("agent tools read and never write (principle 8, §3.4)", () => {
  it("declares every tool non-mutating, so no ungated write is offered", () => {
    const tools = createGitTools(
      contextOf(() => ok()),
      ["workspace-files"],
    );
    expect(tools.map((tool) => tool.requires.mutates)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(tools.every((tool) => tool.requires.writeActionId === null)).toBe(
      true,
    );
  });

  it("contributes no write action at all", () => {
    const manifest = createGitPlugin({
      git: contextOf(() => ok()),
      clock: () => 0,
      scratchDirectory: "/tmp",
    });
    expect(manifest.contributions.writeActions).toBeUndefined();
  });

  it("refuses a tool call with no path instead of reading somewhere arbitrary", async () => {
    const tools = createGitTools(
      contextOf(() => ok()),
      [],
    );
    const status = tools[0];
    if (status === undefined) {
      throw new Error("no status tool");
    }
    expect(await status.call({}, call)).toEqual({
      ok: false,
      content: "this tool needs an absolute path to a checkout",
    });
  });
});
