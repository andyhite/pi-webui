import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkContinuation, deriveDivergence } from "../divergence.js";
import type { CommandExec } from "../exec.js";
import type { WorkspaceFs } from "../fs.js";
import { newWorkspaceId } from "../ids.js";
import { GIT_WORKSPACE_KIND, type WorkspaceKind } from "../kind.js";
import {
  checkReady,
  readinessProvisioned,
  readinessSetupFinished,
  resolveSetup,
} from "../readiness.js";
import { newWorkspaceRecord, type Workspace } from "../workspace.js";
import { humanAuthor } from "../../author.js";
import { newWorkstreamId } from "../../ids.js";
import { createGitWorkspaceKind } from "./kind.js";
import { findCredentialMaterial } from "./host-auth.js";

/**
 * The git kind against real git, in temp directories: local repositories only,
 * no network, so this stays hermetic and fast while proving the mechanics that
 * a recorded fake cannot — that the argv this package builds is argv git
 * accepts, and that a provisioned workspace on disk looks the way §3.4 says.
 */

const NOW = 1_700_000_000_000;

const nodeExec: CommandExec = (command) =>
  new Promise((resolve, reject) => {
    const child = spawn(command.program, [...command.args], {
      cwd: command.cwd,
      env: { ...command.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });

const nodeFs: WorkspaceFs = {
  readDirectory: async (path) => {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      directory: entry.isDirectory(),
    }));
  },
};

/** Setup git, with an identity of its own so commits work on any host. */
function git(cwd: string, ...args: string[]): Promise<string> {
  return nodeExec({
    program: "git",
    args: [
      "-c",
      "user.name=PlotRoom Test",
      "-c",
      "user.email=test@plotroom.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } as Record<string, string>,
  }).then((result) => {
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout;
  });
}

let root: string;
let origin: string;
let primary: string;
let kind: WorkspaceKind;

function workspaceRecord(config: Record<string, unknown>): Workspace {
  return newWorkspaceRecord(
    {
      id: newWorkspaceId(),
      workstreamId: newWorkstreamId(),
      kind: GIT_WORKSPACE_KIND,
      config,
      createdBy: humanAuthor,
    },
    NOW,
  );
}

async function provisionInto(
  config: Record<string, unknown>,
): Promise<{ workspace: Workspace; notes: readonly string[] }> {
  const record = workspaceRecord(config);
  const outcome = await kind.provision({
    workspaceId: record.id,
    kind: GIT_WORKSPACE_KIND,
    config,
    requestedAt: NOW,
  });
  if (!outcome.provisioned) {
    throw new Error(`provisioning failed: ${outcome.failure.message}`);
  }
  return {
    workspace: { ...record, roots: outcome.roots, provisionCost: outcome.cost },
    notes: outcome.notes,
  };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "plotroom-workspaces-"));
  origin = join(root, "origin.git");
  primary = join(root, "primary");
  mkdirSync(join(root, "work"), { recursive: true });

  await git(root, "init", "--bare", "-b", "main", origin);
  await git(root, "clone", origin, primary);
  writeFileSync(join(primary, "README.md"), "# app\n");
  await git(primary, "add", "README.md");
  await git(primary, "commit", "-m", "chore: first");
  await git(primary, "push", "-u", "origin", "main");

  // Someone else's branch, on the remote only.
  await git(primary, "checkout", "-b", "feat/theirs");
  writeFileSync(join(primary, "theirs.txt"), "their actual commits\n");
  await git(primary, "add", "theirs.txt");
  await git(primary, "commit", "-m", "feat: theirs");
  await git(primary, "push", "origin", "feat/theirs");
  await git(primary, "checkout", "main");
  await git(primary, "branch", "-D", "feat/theirs");
  await git(primary, "update-ref", "-d", "refs/remotes/origin/feat/theirs");

  kind = createGitWorkspaceKind({
    exec: nodeExec,
    fs: nodeFs,
    clock: () => Date.now(),
    hostEnvironment: process.env,
    scratchDirectory: root,
    removeDirectory: (path) => {
      rmSync(path, { recursive: true, force: true });
      return Promise.resolve();
    },
  });
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("provisioning against real git", () => {
  it("takes a branch that exists remotely, with that branch's actual commits (§3.4)", async () => {
    const { workspace, notes } = await provisionInto({
      workspacePath: join(root, "work", "theirs"),
      repositoryPath: primary,
      branch: "feat/theirs",
    });

    expect(notes.join(" ")).toContain("actual commits");
    expect(
      readFileSync(join(root, "work", "theirs", "theirs.txt"), "utf8"),
    ).toContain("their actual commits");

    const status = await kind.status(workspace);
    expect(status.units[0]).toMatchObject({
      branch: "feat/theirs",
      upstream: "origin/feat/theirs",
      ahead: 0,
      behind: 0,
      uncommitted: [],
    });
  });

  it("derives a branch from the template and reports what it cost (§3.4)", async () => {
    const { workspace } = await provisionInto({
      workspacePath: join(root, "work", "derived"),
      repositoryPath: primary,
      branchTemplate: "{type}/{ticket}-{title}",
      branchInputs: { type: "feat", ticket: "OXY-7", title: "Git Workspaces" },
    });

    expect(workspace.roots[0]?.branch).toBe("feat/oxy-7-git-workspaces");
    expect(workspace.provisionCost).toMatchObject({
      strategy: "worktree",
      sharedCache: "hit",
    });
    expect(workspace.provisionCost?.elapsedMillis).toBeGreaterThanOrEqual(0);

    const status = await kind.status(workspace);
    expect(status.units[0]?.branch).toBe("feat/oxy-7-git-workspaces");
  });

  it("never renames or re-derives a branch that already exists", async () => {
    await git(primary, "branch", "already-mine", "main");

    const { workspace, notes } = await provisionInto({
      workspacePath: join(root, "work", "existing"),
      repositoryPath: primary,
      branch: "already-mine",
      branchTemplate: "{type}/{title}",
      branchInputs: { type: "feat", title: "something else" },
    });

    expect(workspace.roots[0]?.branch).toBe("already-mine");
    expect(notes.join(" ")).toContain("already exists locally");
  });

  it("writes no credential into the workspace's git config or remotes (§3.4)", async () => {
    const workspacePath = join(root, "work", "host-auth");
    await provisionInto({
      workspacePath,
      repositoryPath: primary,
      branch: "feat/host-auth",
    });

    const config = readFileSync(join(primary, ".git", "config"), "utf8");
    const worktreeGitFile = readFileSync(join(workspacePath, ".git"), "utf8");

    expect(findCredentialMaterial(config)).toEqual([]);
    expect(config).toContain(origin);
    expect(worktreeGitFile).not.toMatch(/token|password/iu);
  });
});

describe("cloning against real git", () => {
  it("populates a shared mirror, reuses it, and writes a plain remote (§3.4)", async () => {
    const cacheDir = join(root, "cache");
    mkdirSync(cacheDir, { recursive: true });

    const first = await provisionInto({
      workspacePath: join(root, "work", "cloned"),
      remoteUrl: origin,
      cacheDir,
      branch: "feat/theirs",
      strategy: "clone",
    });

    expect(first.workspace.provisionCost).toMatchObject({
      strategy: "clone",
      sharedCache: "miss",
    });
    expect(
      readFileSync(join(root, "work", "cloned", "theirs.txt"), "utf8"),
    ).toContain("their actual commits");

    const clonedConfig = readFileSync(
      join(root, "work", "cloned", ".git", "config"),
      "utf8",
    );
    expect(findCredentialMaterial(clonedConfig)).toEqual([]);
    expect(clonedConfig).toContain(origin);

    const second = await provisionInto({
      workspacePath: join(root, "work", "cloned-again"),
      remoteUrl: origin,
      cacheDir,
      branch: "feat/second",
      strategy: "clone",
    });

    expect(second.workspace.provisionCost?.sharedCache).toBe("hit");

    const removed = await kind.remove(second.workspace, { force: false });
    expect(removed.removed).toBe(true);
  }, 30_000);
});

describe("live status reflects changes the product did not make (§3.4)", () => {
  it("sees a file a terminal changed, and the commits a terminal made", async () => {
    const workspacePath = join(root, "work", "live");
    const { workspace } = await provisionInto({
      workspacePath,
      repositoryPath: primary,
      branch: "feat/live",
    });

    writeFileSync(join(workspacePath, "README.md"), "# app\nedited by hand\n");
    writeFileSync(join(workspacePath, "scratch.txt"), "note\n");

    const dirty = await kind.status(workspace);
    expect(dirty.units[0]?.uncommitted).toEqual(["README.md"]);
    expect(dirty.units[0]?.untracked).toEqual(["scratch.txt"]);

    await git(workspacePath, "add", "README.md");
    await git(workspacePath, "commit", "-m", "docs: by hand");

    const committed = await kind.status(workspace);
    expect(committed.units[0]?.uncommitted).toEqual([]);
    expect(committed.units[0]?.untracked).toEqual(["scratch.txt"]);
    expect(committed.units[0]?.head).not.toBe(dirty.units[0]?.head);
  });
});

describe("divergence and the continuation gate (§3.4, §4.3)", () => {
  it("lets a session continue when nothing moved", async () => {
    const { workspace } = await provisionInto({
      workspacePath: join(root, "work", "steady"),
      repositoryPath: primary,
      branch: "feat/steady",
    });

    const before = await kind.fingerprint(workspace);
    const after = await kind.fingerprint(workspace);

    expect(checkContinuation(deriveDivergence(before, after)).allowed).toBe(
      true,
    );
  });

  it("forces fresh after a rebase rewrote the history a session worked from", async () => {
    const workspacePath = join(root, "work", "rebased");
    const { workspace } = await provisionInto({
      workspacePath,
      repositoryPath: primary,
      branch: "feat/rebased",
    });

    writeFileSync(join(workspacePath, "work.txt"), "session output\n");
    await git(workspacePath, "add", "work.txt");
    await git(workspacePath, "commit", "-m", "feat: session work");

    const before = await kind.fingerprint(workspace);

    await git(
      workspacePath,
      "commit",
      "--amend",
      "-m",
      "feat: rewritten by hand",
    );

    const after = await kind.fingerprint(workspace);
    const priorHeads = new Map(
      before.units.map((unit) => [unit.rootKey, unit.head ?? ""]),
    );
    const probe = await kind.probeAncestry(workspace, priorHeads);
    const report = deriveDivergence(before, after, {
      priorHeadReachable: probe,
    });

    expect(report.changes.map((change) => change.kind)).toContain(
      "history-rewritten",
    );
    const gate = checkContinuation(report);
    expect(gate.allowed).toBe(false);
    expect(gate.message).toContain("changed outside this session");
  });

  it("reports new commits without calling them a rewrite", async () => {
    const workspacePath = join(root, "work", "advanced");
    const { workspace } = await provisionInto({
      workspacePath,
      repositoryPath: primary,
      branch: "feat/advanced",
    });

    const before = await kind.fingerprint(workspace);

    writeFileSync(join(workspacePath, "more.txt"), "more\n");
    await git(workspacePath, "add", "more.txt");
    await git(workspacePath, "commit", "-m", "feat: more");

    const after = await kind.fingerprint(workspace);
    const probe = await kind.probeAncestry(
      workspace,
      new Map(before.units.map((unit) => [unit.rootKey, unit.head ?? ""])),
    );
    const report = deriveDivergence(before, after, {
      priorHeadReachable: probe,
    });

    expect(report.changes.map((change) => change.kind)).toEqual([
      "commits-added",
    ]);
  });
});

describe("readiness against a real setup step (§3.4)", () => {
  it("keeps the whole output of a setup step and opens the gate on success", async () => {
    const { workspace } = await provisionInto({
      workspacePath: join(root, "work", "ready"),
      repositoryPath: primary,
      branch: "feat/ready",
    });

    const setup = resolveSetup(
      {
        program: "node",
        args: ["-e", "console.log('installed'); console.error('a warning')"],
        workingSubdirectory: "",
        label: "node setup",
      },
      null,
    );
    if (setup === null) throw new Error("setup should resolve");

    const attempt = await kind.runSetup(workspace, setup, NOW);
    const readiness = readinessSetupFinished(
      readinessProvisioned(workspace.readiness, setup, NOW),
      attempt,
      NOW,
    );

    expect(attempt.outcome).toBe("succeeded");
    expect(attempt.stdout).toContain("installed");
    expect(attempt.stderr).toContain("a warning");
    expect(checkReady(readiness)).toEqual({ ready: true });
  });

  it("blocks the workspace when the setup step fails, with its output kept", async () => {
    const { workspace } = await provisionInto({
      workspacePath: join(root, "work", "not-ready"),
      repositoryPath: primary,
      branch: "feat/not-ready",
    });

    const setup = resolveSetup(null, {
      program: "node",
      args: [
        "-e",
        "console.error('ERR_PNPM_OUTDATED_LOCKFILE'); process.exit(1)",
      ],
      workingSubdirectory: "",
      label: "pnpm install",
    });
    if (setup === null) throw new Error("setup should resolve");

    const attempt = await kind.runSetup(workspace, setup, NOW);
    const readiness = readinessSetupFinished(
      readinessProvisioned(workspace.readiness, setup, NOW),
      attempt,
      NOW,
    );

    expect(attempt.outcome).toBe("failed");
    expect(attempt.exitCode).toBe(1);
    expect(attempt.stderr).toContain("ERR_PNPM_OUTDATED_LOCKFILE");

    const check = checkReady(readiness);
    expect(check.ready).toBe(false);
    if (check.ready) return;
    expect(check.refusal.reason).toBe("setup-failed");
    expect(check.refusal.attemptId).toBe(attempt.id);
  });

  it("reports a setup step that cannot start at all", async () => {
    const { workspace } = await provisionInto({
      workspacePath: join(root, "work", "no-such-setup"),
      repositoryPath: primary,
      branch: "feat/no-such-setup",
    });

    const setup = resolveSetup(
      {
        program: "plotroom-no-such-program",
        args: [],
        workingSubdirectory: "",
        label: "missing setup",
      },
      null,
    );
    if (setup === null) throw new Error("setup should resolve");

    const attempt = await kind.runSetup(workspace, setup, NOW);

    expect(attempt.outcome).toBe("failed");
    expect(attempt.failure).toContain("could not be started");
  });
});

describe("removal protections against real git (§3.4)", () => {
  it("refuses to remove a workspace with uncommitted changes until forced", async () => {
    const workspacePath = join(root, "work", "dirty");
    const { workspace } = await provisionInto({
      workspacePath,
      repositoryPath: primary,
      branch: "feat/dirty",
    });
    writeFileSync(join(workspacePath, "unsaved.txt"), "work in progress\n");

    const refused = await kind.remove(workspace, { force: false });
    expect(refused).toMatchObject({
      removed: false,
      refusal: { reason: "uncommitted_changes", forcible: true },
    });

    const forced = await kind.remove(workspace, { force: true });
    expect(forced.removed).toBe(true);
  });

  it("never removes the primary checkout, force or not", async () => {
    const record = workspaceRecord({ workspacePath: primary });
    const asPrimary: Workspace = {
      ...record,
      roots: [
        { key: "root", path: primary, branch: "main", primaryCheckout: true },
      ],
    };

    for (const force of [false, true]) {
      expect(await kind.remove(asPrimary, { force })).toMatchObject({
        removed: false,
        refusal: { reason: "primary_checkout", forcible: false },
      });
    }
  });

  it("never removes a workspace sitting on the default branch", async () => {
    const workspacePath = join(root, "work", "on-default");
    await git(primary, "worktree", "add", "--detach", workspacePath, "main");
    await git(workspacePath, "checkout", "-B", "main-copy", "main");
    await git(workspacePath, "config", "init.defaultBranch", "main-copy");

    const record = workspaceRecord({ workspacePath });
    const workspace: Workspace = {
      ...record,
      roots: [
        {
          key: "root",
          path: workspacePath,
          branch: "main-copy",
          primaryCheckout: false,
        },
      ],
    };

    for (const force of [false, true]) {
      expect(await kind.remove(workspace, { force })).toMatchObject({
        removed: false,
        refusal: { reason: "default_branch", forcible: false },
      });
    }
  });
});

describe("discovery against real repositories (§3.4, principle 6)", () => {
  it("finds the checkout and its worktrees, marking the primary one", async () => {
    const result = await kind.discover?.({
      searchPaths: [root],
      maxDepth: 3,
    });

    expect(result).toBeDefined();
    if (result === undefined) return;

    const found = new Map(
      result.repositories.map((repository) => [repository.path, repository]),
    );
    expect(found.get(primary)).toMatchObject({
      primaryCheckout: true,
      currentBranch: "main",
    });
    expect(found.get(join(root, "work", "steady"))).toMatchObject({
      primaryCheckout: false,
      currentBranch: "feat/steady",
    });
  });
});
