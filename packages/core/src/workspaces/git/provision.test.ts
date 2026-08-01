import { describe, expect, it } from "vitest";

import type { CommandExec, CommandResult, ShellCommand } from "../exec.js";
import { newWorkspaceId } from "../ids.js";
import { GIT_WORKSPACE_KIND, type ProvisionRequest } from "../kind.js";
import { provisionGitWorkspace, type GitProvisionDeps } from "./provision.js";

const NOW = 1_700_000_000_000;

interface Rule {
  readonly match: (args: readonly string[]) => boolean;
  readonly result: Partial<CommandResult>;
}

/**
 * A recorded git: no repository, no process. Provisioning is exercised as the
 * exact argv it produces, which is also what makes the environment assertions
 * in `host-auth.test.ts` meaningful.
 */
class FakeGit {
  readonly commands: ShellCommand[] = [];
  readonly rules: Rule[] = [];

  on(prefix: readonly string[], result: Partial<CommandResult>): this {
    this.rules.push({
      match: (args) => prefix.every((part, index) => args[index] === part),
      result,
    });
    return this;
  }

  onContaining(needle: string, result: Partial<CommandResult>): this {
    this.rules.push({ match: (args) => args.includes(needle), result });
    return this;
  }

  readonly exec: CommandExec = (command) => {
    this.commands.push(command);
    for (const rule of this.rules) {
      if (rule.match(command.args)) {
        return Promise.resolve({
          exitCode: 0,
          stdout: "",
          stderr: "",
          ...rule.result,
        });
      }
    }
    const subcommand = command.args[0];
    const readOnly =
      subcommand === "rev-parse" ||
      subcommand === "symbolic-ref" ||
      subcommand === "config";
    return Promise.resolve({
      exitCode: readOnly ? 1 : 0,
      stdout: "",
      stderr: "",
    });
  };

  argv(): readonly (readonly string[])[] {
    return this.commands.map((command) => command.args);
  }

  ran(prefix: readonly string[]): boolean {
    return this.argv().some((args) =>
      prefix.every((part, index) => args[index] === part),
    );
  }
}

function deps(git: FakeGit, overrides: Partial<GitProvisionDeps> = {}) {
  let tick = NOW;
  return {
    git: { exec: git.exec, hostEnvironment: { PATH: "/usr/bin" } },
    clock: () => {
      tick += 250;
      return tick;
    },
    scratchDirectory: "/state",
    ...overrides,
  } satisfies GitProvisionDeps;
}

function request(config: Record<string, unknown>): ProvisionRequest {
  return {
    workspaceId: newWorkspaceId(),
    kind: GIT_WORKSPACE_KIND,
    config,
    requestedAt: NOW,
  };
}

const worktreeConfig = {
  workspacePath: "/work/app-feat-thing",
  repositoryPath: "/repos/app",
  branchTemplate: "{type}/{ticket}-{title}",
  branchInputs: { type: "feat", ticket: "OXY-1", title: "The Thing" },
};

describe("provisioning by worktree", () => {
  it("checks out an existing local branch rather than recreating it (§3.4)", async () => {
    const git = new FakeGit().onContaining(
      "refs/heads/feat/oxy-1-the-thing^{commit}",
      {
        exitCode: 0,
        stdout: "abc\n",
      },
    );

    const outcome = await provisionGitWorkspace(
      deps(git),
      request(worktreeConfig),
    );

    expect(outcome.provisioned).toBe(true);
    if (!outcome.provisioned) return;
    expect(
      git.ran([
        "worktree",
        "add",
        "/work/app-feat-thing",
        "feat/oxy-1-the-thing",
      ]),
    ).toBe(true);
    expect(git.ran(["worktree", "add", "-b"])).toBe(false);
    expect(outcome.notes.join(" ")).toContain("already exists locally");
    expect(outcome.roots).toEqual([
      {
        key: "root",
        path: "/work/app-feat-thing",
        branch: "feat/oxy-1-the-thing",
        primaryCheckout: false,
      },
    ]);
  });

  it("takes a branch that exists remotely from the remote, with its commits (§3.4)", async () => {
    const git = new FakeGit()
      .onContaining("refs/remotes/origin/feat/oxy-1-the-thing^{commit}", {
        exitCode: 0,
        stdout: "abc\n",
      })
      .on(["config", "--get", "remote.origin.url"], {
        exitCode: 0,
        stdout: "git@github.com:acme/app.git\n",
      });

    const outcome = await provisionGitWorkspace(
      deps(git),
      request(worktreeConfig),
    );

    expect(outcome.provisioned).toBe(true);
    if (!outcome.provisioned) return;
    expect(
      git.ran([
        "worktree",
        "add",
        "--track",
        "-b",
        "feat/oxy-1-the-thing",
        "/work/app-feat-thing",
        "origin/feat/oxy-1-the-thing",
      ]),
    ).toBe(true);
    expect(outcome.notes.join(" ")).toContain("actual commits");
  });

  it("fetches the branch from the remote before deciding it does not exist", async () => {
    const git = new FakeGit().on(["config", "--get", "remote.origin.url"], {
      exitCode: 0,
      stdout: "git@github.com:acme/app.git\n",
    });

    await provisionGitWorkspace(deps(git), request(worktreeConfig));

    expect(
      git.ran([
        "fetch",
        "origin",
        "refs/heads/feat/oxy-1-the-thing:refs/remotes/origin/feat/oxy-1-the-thing",
      ]),
    ).toBe(true);
  });

  it("starts a new branch from the remote's default when there is none anywhere", async () => {
    const git = new FakeGit().on(
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      { exitCode: 0, stdout: "origin/main\n" },
    );

    const outcome = await provisionGitWorkspace(
      deps(git),
      request(worktreeConfig),
    );

    expect(
      git.ran([
        "worktree",
        "add",
        "-b",
        "feat/oxy-1-the-thing",
        "/work/app-feat-thing",
        "origin/main",
      ]),
    ).toBe(true);
    expect(outcome.provisioned && outcome.notes.join(" ")).toContain(
      "started from origin/main",
    );
  });

  it("never re-derives a branch the workspace already has", async () => {
    const git = new FakeGit();

    await provisionGitWorkspace(
      deps(git),
      request({ ...worktreeConfig, branch: "someone-elses-branch" }),
    );

    expect(git.argv().flat()).toContain("someone-elses-branch");
    expect(git.argv().flat()).not.toContain("feat/oxy-1-the-thing");
  });

  it("reports the cost: strategy, shared storage, time, and disk (§3.4)", async () => {
    const git = new FakeGit();

    const outcome = await provisionGitWorkspace(
      deps(git, { diskUsage: () => Promise.resolve(4_096) }),
      request(worktreeConfig),
    );

    expect(outcome.provisioned && outcome.cost).toMatchObject({
      strategy: "worktree",
      sharedCache: "hit",
      bytesOnDisk: 4_096,
    });
    expect(outcome.provisioned && outcome.cost.elapsedMillis).toBeGreaterThan(
      0,
    );
  });

  it("reports unknown disk cost as unknown, never as zero", async () => {
    const outcome = await provisionGitWorkspace(
      deps(new FakeGit()),
      request(worktreeConfig),
    );

    expect(outcome.provisioned && outcome.cost.bytesOnDisk).toBeNull();
  });

  it("reports the mechanism's own error when git refuses", async () => {
    const git = new FakeGit().on(["worktree", "add"], {
      exitCode: 128,
      stderr:
        "fatal: 'feat/oxy-1-the-thing' is already checked out at '/work/other'",
    });

    const outcome = await provisionGitWorkspace(
      deps(git),
      request(worktreeConfig),
    );

    expect(outcome.provisioned).toBe(false);
    if (outcome.provisioned) return;
    expect(outcome.failure.reason).toBe("mechanism_failed");
    expect(outcome.failure.message).toContain("already checked out");
    expect(outcome.failure.log.length).toBeGreaterThan(0);
  });
});

describe("provisioning by clone", () => {
  const cloneConfig = {
    workspacePath: "/work/app-feat-thing",
    remoteUrl: "git@github.com:acme/app.git",
    cacheDir: "/state/cache",
    branch: "feat/thing",
  };

  it("populates the shared mirror on a miss and clones against it (§3.4 cost awareness)", async () => {
    const git = new FakeGit();

    const outcome = await provisionGitWorkspace(
      deps(git),
      request(cloneConfig),
    );

    expect(git.ran(["clone", "--mirror"])).toBe(true);
    expect(
      git.ran([
        "clone",
        "--reference-if-able",
        "/state/cache/git-github-com-acme-app.git",
        "--dissociate",
      ]),
    ).toBe(true);
    expect(outcome.provisioned && outcome.cost.sharedCache).toBe("miss");
  });

  it("updates and reuses the mirror on a hit", async () => {
    const git = new FakeGit().on(
      ["-C", "/state/cache/git-github-com-acme-app.git", "rev-parse"],
      { exitCode: 0, stdout: "true\n" },
    );

    const outcome = await provisionGitWorkspace(
      deps(git),
      request(cloneConfig),
    );

    expect(git.ran(["remote", "update", "--prune"])).toBe(true);
    expect(git.ran(["clone", "--mirror"])).toBe(false);
    expect(outcome.provisioned && outcome.cost.sharedCache).toBe("hit");
  });

  it("continues without the cache when the mirror cannot be built", async () => {
    const git = new FakeGit().on(["clone", "--mirror"], {
      exitCode: 128,
      stderr: "fatal: could not create leading directories",
    });

    const outcome = await provisionGitWorkspace(
      deps(git),
      request(cloneConfig),
    );

    expect(outcome.provisioned).toBe(true);
    expect(outcome.provisioned && outcome.cost.sharedCache).toBe("unavailable");
    expect(outcome.provisioned && outcome.notes.join(" ")).toContain(
      "without it",
    );
  });

  it("checks out a branch that exists on the remote", async () => {
    const git = new FakeGit().onContaining(
      "refs/remotes/origin/feat/thing^{commit}",
      {
        exitCode: 0,
        stdout: "abc\n",
      },
    );

    const outcome = await provisionGitWorkspace(
      deps(git),
      request(cloneConfig),
    );

    expect(git.ran(["checkout", "--track", "origin/feat/thing"])).toBe(true);
    expect(outcome.provisioned && outcome.notes.join(" ")).toContain(
      "actual commits",
    );
  });
});

describe("provisioning refusals", () => {
  it("refuses configuration it cannot act on, before touching git", async () => {
    const git = new FakeGit();

    const outcome = await provisionGitWorkspace(
      deps(git),
      request({ workspacePath: "/work/app" }),
    );

    expect(outcome.provisioned).toBe(false);
    if (outcome.provisioned) return;
    expect(outcome.failure.reason).toBe("invalid_config");
    expect(git.commands).toEqual([]);
  });

  it("refuses a branch template that produces nothing", async () => {
    const outcome = await provisionGitWorkspace(
      deps(new FakeGit()),
      request({ ...worktreeConfig, branchInputs: {} }),
    );

    expect(outcome.provisioned).toBe(false);
    if (outcome.provisioned) return;
    expect(outcome.failure.reason).toBe("invalid_config");
  });
});
