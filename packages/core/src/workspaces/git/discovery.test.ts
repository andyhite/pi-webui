import { describe, expect, it } from "vitest";

import type { CommandExec, ShellCommand } from "../exec.js";
import type { DirectoryEntry, WorkspaceFs } from "../fs.js";
import {
  checkReadOnlyGit,
  discoverGitRepositories,
  parseRemotes,
} from "./discovery.js";

const TREE: Readonly<Record<string, readonly DirectoryEntry[]>> = {
  "/code": [
    { name: "app", directory: true },
    { name: "notes.md", directory: false },
    { name: ".cache", directory: true },
    { name: "nested", directory: true },
  ],
  "/code/app": [
    { name: ".git", directory: true },
    { name: "src", directory: true },
  ],
  "/code/app/src": [{ name: "index.ts", directory: false }],
  "/code/nested": [{ name: "service", directory: true }],
  "/code/nested/service": [{ name: ".git", directory: false }],
};

function fakeFs(tree = TREE): WorkspaceFs {
  return {
    readDirectory: (path) => {
      const entries = tree[path];
      if (entries === undefined) {
        return Promise.reject(new Error("ENOENT: no such directory"));
      }
      return Promise.resolve(entries);
    },
  };
}

class RecordingGit {
  readonly commands: ShellCommand[] = [];

  constructor(
    private readonly answers: Readonly<
      Record<string, { exitCode: number; stdout: string }>
    > = {},
  ) {}

  readonly exec: CommandExec = (command) => {
    this.commands.push(command);
    const key = command.args.join(" ");
    const answer = this.answers[key];
    return Promise.resolve({
      exitCode: answer?.exitCode ?? 1,
      stdout: answer?.stdout ?? "",
      stderr: "",
    });
  };
}

const context = (git: RecordingGit) => ({
  git: { exec: git.exec, hostEnvironment: { PATH: "/usr/bin" } },
  fs: fakeFs(),
});

describe("discoverGitRepositories", () => {
  it("finds repositories under the configured search paths (§3.4)", async () => {
    const git = new RecordingGit();

    const result = await discoverGitRepositories(context(git), {
      searchPaths: ["/code"],
      maxDepth: 3,
    });

    expect(result.repositories.map((repository) => repository.path)).toEqual([
      "/code/app",
      "/code/nested/service",
    ]);
    expect(result.repositories[0]?.name).toBe("app");
  });

  it("reports what it could not read instead of dropping it", async () => {
    const git = new RecordingGit();

    const result = await discoverGitRepositories(context(git), {
      searchPaths: ["/code", "/missing"],
      maxDepth: 2,
    });

    expect(result.unreadable).toHaveLength(1);
    expect(result.unreadable[0]).toContain("/missing");
  });

  it("places nothing — a discovered repository carries no workspace (principle 6)", async () => {
    const git = new RecordingGit();

    const result = await discoverGitRepositories(context(git), {
      searchPaths: ["/code"],
      maxDepth: 3,
    });

    for (const repository of result.repositories) {
      expect(Object.keys(repository).sort()).toEqual([
        "currentBranch",
        "defaultBranch",
        "kind",
        "name",
        "path",
        "primaryCheckout",
        "remotes",
      ]);
    }
  });

  it("runs only read-only git commands, so a scan cannot change a repository", async () => {
    const git = new RecordingGit();

    await discoverGitRepositories(context(git), {
      searchPaths: ["/code"],
      maxDepth: 3,
    });

    expect(git.commands.length).toBeGreaterThan(0);
    for (const command of git.commands) {
      expect(checkReadOnlyGit(command.args)).toEqual({ readOnly: true });
    }
  });

  it("marks the primary checkout, which is protected from removal (§3.4)", async () => {
    const git = new RecordingGit({
      "rev-parse --git-dir": { exitCode: 0, stdout: ".git\n" },
      "rev-parse --git-common-dir": { exitCode: 0, stdout: ".git\n" },
      "rev-parse --abbrev-ref HEAD": { exitCode: 0, stdout: "main\n" },
      "symbolic-ref --short refs/remotes/origin/HEAD": {
        exitCode: 0,
        stdout: "origin/main\n",
      },
      "config --get-regexp ^remote\\..*\\.url$": {
        exitCode: 0,
        stdout: "remote.origin.url git@github.com:acme/app.git\n",
      },
    });

    const result = await discoverGitRepositories(context(git), {
      searchPaths: ["/code"],
      maxDepth: 3,
    });

    expect(result.repositories[0]).toMatchObject({
      primaryCheckout: true,
      currentBranch: "main",
      defaultBranch: "main",
      remotes: [{ name: "origin", url: "git@github.com:acme/app.git" }],
    });
  });

  it("does not mark a linked worktree as the primary checkout", async () => {
    const git = new RecordingGit({
      "rev-parse --git-dir": {
        exitCode: 0,
        stdout: "/repos/app/.git/worktrees/app-feat-thing\n",
      },
      "rev-parse --git-common-dir": {
        exitCode: 0,
        stdout: "/repos/app/.git\n",
      },
    });

    const result = await discoverGitRepositories(context(git), {
      searchPaths: ["/code"],
      maxDepth: 3,
    });

    expect(result.repositories[0]?.primaryCheckout).toBe(false);
  });
});

describe("checkReadOnlyGit", () => {
  it.each([
    [["rev-parse", "--git-dir"]],
    [["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]],
    [["config", "--get", "init.defaultBranch"]],
    [["remote", "-v"]],
  ])("allows %s", (args) => {
    expect(checkReadOnlyGit(args)).toEqual({ readOnly: true });
  });

  it.each([
    [["clone", "https://example.com/app.git"]],
    [["fetch", "origin"]],
    [["config", "user.email", "someone@example.com"]],
    [["remote", "update"]],
    [[]],
  ])("refuses %s", (args) => {
    expect(checkReadOnlyGit(args).readOnly).toBe(false);
  });
});

describe("parseRemotes", () => {
  it("reads remotes from config output", () => {
    expect(
      parseRemotes(
        "remote.origin.url git@github.com:acme/app.git\nremote.fork.url git@github.com:me/app.git\n",
      ),
    ).toEqual([
      { name: "origin", url: "git@github.com:acme/app.git" },
      { name: "fork", url: "git@github.com:me/app.git" },
    ]);
  });
});
