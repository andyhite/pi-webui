import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PluginCallRefusedError,
  PluginHost,
  type CoreId,
  type PermissionGrant,
  type PluginActor,
} from "@plotroom/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The git plugin **in the real worker_threads host**, against **real git** in temp
 * directories: local repositories only, so this stays hermetic and fast while
 * proving what a recorded fake cannot — that the argv this plugin builds is argv git
 * accepts, that the shipped entry point conforms, and that every contribution it
 * declares answers an invocation across the worker boundary.
 *
 * It loads `dist/index.js`, which is exactly what the product would load in the box.
 */

const entry = new URL("../dist/index.js", import.meta.url);

const coreId = (value: string): CoreId => value as unknown as CoreId;

const actor: PluginActor = {
  sessionId: coreId("sess_1"),
  workstreamId: coreId("wst_1"),
};

const grants = (...permissionIds: string[]): PermissionGrant[] =>
  permissionIds.map((permissionId) => ({
    pluginId: "coding-git",
    permissionId,
    state: "granted" as const,
    answeredAt: 1,
  }));

const allGrants = grants("workspace-files", "repository-remotes");

const hosts: PluginHost[] = [];

const load = async (
  granted: PermissionGrant[] = allGrants,
): Promise<PluginHost> => {
  const host = await PluginHost.load(entry, {
    grants: granted,
    // Real git in a real worker: generous, but still bounded.
    callTimeoutMs: 30_000,
  });
  hosts.push(host);
  return host;
};

const git = (cwd: string, ...args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      "git",
      [
        "-c",
        "user.name=PlotRoom Test",
        "-c",
        "user.email=test@plotroom.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "init.defaultBranch=main",
        ...args,
      ],
      { cwd, env: { ...process.env }, shell: false },
    );
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
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`git ${args.join(" ")} failed: ${stderr}`));
      }
    });
  });

let root = "";
let repository = "";
let workspacePath = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "plotroom-git-plugin-"));
  repository = join(root, "source");
  workspacePath = join(root, "workspace");
  await git(root, "init", "-q", repository);
  await writeFile(join(repository, "README.md"), "# source\n", "utf8");
  await git(repository, "add", "-A");
  await git(repository, "commit", "-qm", "initial commit");
});

afterAll(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.dispose()));
});

describe("the shipped git plugin in the worker host (§9.4, §10.2)", () => {
  it("loads, conforms, and declares the contributions the port promised", async () => {
    const host = await load();

    expect(host.health.status).toBe("ready");
    const descriptor = host.descriptor;
    expect(descriptor?.id).toBe("coding-git");
    expect(descriptor?.contractVersion).toBe(1);
    // Conformance ran at the boundary: a nonconformant manifest would have made
    // the plugin unavailable with the problems listed instead.
    const points = new Set(descriptor?.contributions.map((one) => one.point));
    expect(points).toEqual(
      new Set([
        "workspace-kind",
        "concept-producer",
        "content-renderer",
        "card-renderer",
        "condition-check",
        "agent-tool",
        "command-definition",
      ]),
    );
    // No credential is asked for: workspace git authentication is the host's (§3.4).
    expect(
      descriptor?.permissions.map((request) => request.scope.kind).sort(),
    ).toEqual(["filesystem", "network"]);
  });

  it("serves every method of the git workspace kind (§3.4)", async () => {
    const host = await load();
    const config = {
      workspacePath,
      repositoryPath: repository,
      branch: "feat/plugin-port",
      baseRef: "main",
    };

    // checkConfig refuses its own bad configuration, with the fields.
    const refused = await host.invoke({
      kind: "workspace.checkConfig",
      contributionId: "git",
      config: { repositoryPath: repository },
    });
    expect(refused.valid).toBe(false);
    expect(
      await host.invoke({
        kind: "workspace.checkConfig",
        contributionId: "git",
        config,
      }),
    ).toEqual({ valid: true });

    const provisioned = await host.invoke({
      kind: "workspace.provision",
      contributionId: "git",
      request: {
        workspaceId: coreId("wsp_1"),
        workstreamId: coreId("wst_1"),
        config,
        requestedAt: Date.now(),
      },
    });
    if (!provisioned.provisioned) {
      throw new Error(provisioned.failure.message);
    }
    expect(provisioned.roots).toEqual([
      { rootKey: "root", path: workspacePath },
    ]);
    // Cost is reported, including which mechanism was used and what it reused.
    expect(provisioned.cost.strategy).toBe("worktree");
    expect(provisioned.cost.sharedCache).toBe("hit");
    expect(provisioned.cost.bytesOnDisk).toBeGreaterThan(0);
    expect(provisioned.log.join("\n")).toContain("git worktree add");
    expect(await git(workspacePath, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "feat/plugin-port\n",
    );

    const workspace = {
      workspaceId: coreId("wsp_1"),
      roots: provisioned.roots,
      config,
    };

    const setup = await host.invoke({
      kind: "workspace.runSetup",
      contributionId: "git",
      request: {
        workspace,
        program: "git",
        args: ["--version"],
        workingSubdirectory: "",
        startedAt: Date.now(),
      },
    });
    expect(setup.ok).toBe(true);
    expect(setup.output).toContain("git version");

    const status = await host.invoke({
      kind: "workspace.status",
      contributionId: "git",
      workspace,
    });
    expect(status.readiness).toBe("ready");
    expect(status.units[0]?.branch).toBe("feat/plugin-port");
    expect(status.unavailable).toBeNull();

    const clean = await host.invoke({
      kind: "workspace.fingerprint",
      contributionId: "git",
      workspace,
    });
    expect(clean.units[0]?.dirtyCount).toBe(0);
    expect(clean.units[0]?.unreadable).toBeNull();

    // A hand edit changes the fingerprint, which is how divergence is observed
    // rather than inferred (§3.4, principle 7).
    await writeFile(join(workspacePath, "notes.md"), "hand edit\n", "utf8");
    const dirty = await host.invoke({
      kind: "workspace.fingerprint",
      contributionId: "git",
      workspace,
    });
    expect(dirty.units[0]?.dirtyCount).toBe(1);
    expect(dirty.units[0]?.dirtyDigest).not.toBe(clean.units[0]?.dirtyDigest);
  });

  it("produces diffs and commits, renders them, and checks conditions over them", async () => {
    const host = await load();
    const scope = `path=${workspacePath} base=main`;

    // A commit, so the diff has something committed *and* something uncommitted.
    await writeFile(join(workspacePath, "src.txt"), "committed\n", "utf8");
    await git(workspacePath, "add", "-A");
    await git(workspacePath, "commit", "-qm", "add src and notes");
    await writeFile(join(workspacePath, "src.txt"), "changed\n", "utf8");

    const diffRead = await host.invoke({
      kind: "concept.read",
      contributionId: "workspace-diff",
      request: { scope, externalId: null },
    });
    expect(diffRead.unavailable).toEqual([]);
    const diff = diffRead.objects[0];
    if (diff === undefined) {
      throw new Error("the diff producer returned nothing");
    }
    expect(diff.kind).toBe("diff");
    expect(diff.externalId).toBe(`git:diff:${workspacePath}`);
    // The base is stated, never guessed: everything since the branch point.
    expect(diff.renderings.summary).toContain("since it branched from main");
    expect(diff.renderings.agentContent).toContain("src.txt");

    // A checkout that cannot be read is reported absent, never half-produced (§3.1).
    const missing = await host.invoke({
      kind: "concept.read",
      contributionId: "workspace-diff",
      request: { scope: `path=${join(root, "nowhere")}`, externalId: null },
    });
    expect(missing.objects).toEqual([]);
    expect(missing.unavailable).toHaveLength(1);

    const commitRead = await host.invoke({
      kind: "concept.read",
      contributionId: "workspace-commits",
      request: { scope, externalId: null },
    });
    const commit = commitRead.objects[0];
    if (commit === undefined) {
      throw new Error("the commit producer returned nothing");
    }
    expect(commit.kind).toBe("commit");
    expect(commit.title).toContain("add src and notes");
    // Identity is the sha, so a re-read reconciles rather than duplicating (§3.1).
    expect(commit.externalId).toMatch(/^git:commit:[0-9a-f]{40}$/u);
    const again = await host.invoke({
      kind: "concept.read",
      contributionId: "workspace-commits",
      request: { scope, externalId: commit.externalId },
    });
    expect(again.objects[0]?.externalId).toBe(commit.externalId);

    const content = await host.invoke({
      kind: "content.render",
      contributionId: "git-content",
      object: diff,
    });
    expect(content.content).toContain("src.txt");
    expect(content.truncated).toBeNull();

    const delta = await host.invoke({
      kind: "content.delta",
      contributionId: "git-content",
      previous: {
        ...diff,
        renderings: { ...diff.renderings, agentContent: "" },
      },
      next: diff,
    });
    expect(delta.content).toContain("Newly changed:");

    const card = await host.invoke({
      kind: "card.render",
      contributionId: "git-card",
      object: diff,
      detail: "expanded",
    });
    expect(card.title).toBe(diff.title);
    expect(card.lines.length).toBeGreaterThan(1);

    // met / unmet / unknown are three different answers (principle 3).
    const unmet = await host.invoke({
      kind: "condition.check",
      contributionId: "git_workspace_clean",
      input: { path: workspacePath },
    });
    expect(unmet.state).toBe("unmet");
    expect(unmet.evidence).toContain("src.txt");

    const unknown = await host.invoke({
      kind: "condition.check",
      contributionId: "git_workspace_clean",
      input: { path: join(root, "nowhere") },
    });
    expect(unknown.state).toBe("unknown");

    const commits = await host.invoke({
      kind: "condition.check",
      contributionId: "git_commits_since_base",
      input: { path: workspacePath, base: "main" },
    });
    expect(commits.state).toBe("met");
    expect(commits.evidence).toContain("add src and notes");

    const branch = await host.invoke({
      kind: "condition.check",
      contributionId: "git_branch_is",
      input: { path: workspacePath, branch: "main" },
    });
    expect(branch.state).toBe("unmet");
    expect(branch.evidence).toContain("feat/plugin-port");
  });

  it("answers a tool call as the calling session, and refuses one with none (principle 1)", async () => {
    const host = await load();

    const status = await host.invoke(
      {
        kind: "tool.call",
        contributionId: "git_status",
        input: { path: workspacePath },
      },
      { actor },
    );
    expect(status.ok).toBe(true);
    expect(JSON.parse(status.content)).toMatchObject({
      branch: "feat/plugin-port",
    });

    // There is no invocation shape by which a plugin supplies an actor; a tool call
    // that names no calling session is refused by the host.
    await expect(
      host.invoke({
        kind: "tool.call",
        contributionId: "git_status",
        input: { path: workspacePath },
      }),
    ).rejects.toBeInstanceOf(PluginCallRefusedError);
    expect(host.health.status).toBe("ready");

    const branches = await host.invoke(
      {
        kind: "tool.call",
        contributionId: "git_branches",
        input: { path: workspacePath },
      },
      { actor },
    );
    expect(branches.content).toContain("* feat/plugin-port");
  });

  it("refuses a call whose permission the operator never answered, and raises it (§6.6)", async () => {
    const host = await load([]);

    const refusal = await host
      .invoke({
        kind: "condition.check",
        contributionId: "git_workspace_clean",
        input: { path: workspacePath },
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(refusal).toBeInstanceOf(PluginCallRefusedError);
    const raise = (refusal as PluginCallRefusedError).raise;
    // Unanswered raises through the approvals channel; the call stays blocked.
    expect(raise?.kind).toBe("tool-permission");
    expect(raise?.permissionId).toBe("workspace-files");
    expect(host.health.status).toBe("ready");
  });

  it("removes the workspace it provisioned, refusing to lose uncommitted work first", async () => {
    const host = await load();
    const workspace = {
      workspaceId: coreId("wsp_1"),
      roots: [{ rootKey: "root", path: workspacePath }],
      config: { workspacePath, repositoryPath: repository },
    };

    const refused = await host.invoke({
      kind: "workspace.remove",
      contributionId: "git",
      workspace,
      options: { force: false },
    });
    expect(refused.removed).toBe(false);
    if (!refused.removed) {
      expect(refused.refusal.forcible).toBe(true);
    }

    const removed = await host.invoke({
      kind: "workspace.remove",
      contributionId: "git",
      workspace,
      options: { force: true },
    });
    expect(removed.removed).toBe(true);
    await expect(
      git(repository, "worktree", "list", "--porcelain"),
    ).resolves.not.toContain(workspacePath);
  });
});
