import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  humanAuthor,
  readinessProvisioned,
  type WorkspaceRoot,
} from "@plotroom/core";
import { openDatabase, type PlotroomDatabase } from "./client.js";
import { WorkspaceRefused, WorkspaceStore } from "./workspace-store.js";
import { WorkstreamStore } from "./workstream-store.js";

let dir: string;
let state: PlotroomDatabase;
let workspaces: WorkspaceStore;
let workstreams: WorkstreamStore;
let millis = 1_700_000_000_000;

const clock = () => millis;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-workspaces-"));
  state = openDatabase({ stateDir: dir });
  workspaces = new WorkspaceStore(state, clock);
  workstreams = new WorkstreamStore(state);
});

afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

function workstream(): string {
  return workstreams.create({ author: humanAuthor }).id;
}

function config(path: string) {
  return { workspacePath: path, repositoryPath: "/repos/plotroom" };
}

function root(path: string): WorkspaceRoot {
  return { key: "root", path, branch: "feat/thing", primaryCheckout: false };
}

describe("workspace records", () => {
  it("starts unprovisioned with no roots: provisioning happens at first run", () => {
    const workspace = workspaces.create({
      workstreamId: workstream(),
      kind: "git",
      config: config("/tmp/ws-1"),
      author: humanAuthor,
    });

    expect(workspace.roots).toEqual([]);
    expect(workspace.provisionedAt).toBeNull();
    expect(workspace.readiness.state).toBe("unprovisioned");
  });

  it("refuses a second workspace for one workstream (§3.4)", () => {
    const id = workstream();
    workspaces.create({
      workstreamId: id,
      kind: "git",
      config: config("/tmp/ws-1"),
      author: humanAuthor,
    });

    expect(() =>
      workspaces.create({
        workstreamId: id,
        kind: "git",
        config: config("/tmp/ws-2"),
        author: humanAuthor,
      }),
    ).toThrow(WorkspaceRefused);
  });

  it("refuses a root another workstream's workspace already owns", () => {
    const first = workspaces.create({
      workstreamId: workstream(),
      kind: "git",
      config: config("/tmp/shared"),
      author: humanAuthor,
    });
    workspaces.recordProvisioned(first.id, {
      roots: [root("/tmp/shared")],
      cost: {
        elapsedMillis: 10,
        bytesOnDisk: null,
        sharedCache: "hit",
        strategy: "worktree",
      },
      readiness: readinessProvisioned(first.readiness, null, millis),
    });

    const second = workspaces.create({
      workstreamId: workstream(),
      kind: "git",
      config: config("/tmp/shared"),
      author: humanAuthor,
    });

    expect(() =>
      workspaces.recordProvisioned(second.id, {
        roots: [root("/tmp/shared")],
        cost: {
          elapsedMillis: 10,
          bytesOnDisk: null,
          sharedCache: "hit",
          strategy: "worktree",
        },
        readiness: readinessProvisioned(second.readiness, null, millis),
      }),
    ).toThrow(WorkspaceRefused);
  });

  it("blocks a run with the readiness gate's own visible reason (§3.4)", () => {
    const workspace = workspaces.create({
      workstreamId: workstream(),
      kind: "git",
      config: config("/tmp/ws-1"),
      author: humanAuthor,
    });

    expect(() => workspaces.requireReady(workspace)).toThrow(
      /not provisioned/iu,
    );

    const provisioned = workspaces.recordProvisioned(workspace.id, {
      roots: [root("/tmp/ws-1")],
      cost: {
        elapsedMillis: 25,
        bytesOnDisk: 4096,
        sharedCache: "miss",
        strategy: "clone",
      },
      readiness: readinessProvisioned(workspace.readiness, null, millis),
    });

    expect(provisioned.readiness.state).toBe("ready");
    expect(provisioned.provisionCost?.strategy).toBe("clone");
    expect(() => workspaces.requireReady(provisioned)).not.toThrow();
  });

  it("frees the workstream for a new workspace once removed", () => {
    const id = workstream();
    const workspace = workspaces.create({
      workstreamId: id,
      kind: "git",
      config: config("/tmp/ws-1"),
      author: humanAuthor,
    });

    millis += 1000;
    workspaces.remove(workspace.id);

    expect(workspaces.forWorkstream(id)).toBeNull();
    expect(() =>
      workspaces.create({
        workstreamId: id,
        kind: "git",
        config: config("/tmp/ws-2"),
        author: humanAuthor,
      }),
    ).not.toThrow();
  });
});
