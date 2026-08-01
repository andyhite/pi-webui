import { describe, expect, it } from "vitest";

import { humanAuthor } from "../author.js";
import { newWorkstreamId } from "../ids.js";
import { newWorkspaceId } from "./ids.js";
import { GIT_WORKSPACE_KIND } from "./kind.js";
import {
  checkRootOwnership,
  checkWorkspaceBoundary,
  newWorkspaceRecord,
  workspaceRoot,
  type Workspace,
  type WorkspaceRoot,
} from "./workspace.js";

const NOW = 1_700_000_000_000;

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  const base = newWorkspaceRecord(
    {
      id: newWorkspaceId(),
      workstreamId: newWorkstreamId(),
      kind: GIT_WORKSPACE_KIND,
      config: { repositoryPath: "/repos/app" },
      createdBy: humanAuthor,
    },
    NOW,
  );
  return { ...base, ...overrides };
}

function root(path: string, overrides: Partial<WorkspaceRoot> = {}) {
  return {
    key: "root",
    path,
    branch: "feat/thing",
    primaryCheckout: false,
    ...overrides,
  };
}

describe("workspace record", () => {
  it("starts unprovisioned with no roots — creation does not provision (§3.4, §3.5)", () => {
    const workspace = makeWorkspace();

    expect(workspace.roots).toEqual([]);
    expect(workspace.readiness.state).toBe("unprovisioned");
    expect(workspace.provisionedAt).toBeNull();
    expect(workspace.provisionCost).toBeNull();
  });

  it("finds a root by key", () => {
    const workspace = makeWorkspace({ roots: [root("/work/app")] });

    expect(workspaceRoot(workspace, "root")?.path).toBe("/work/app");
    expect(workspaceRoot(workspace, "backend")).toBeNull();
  });
});

describe("checkWorkspaceBoundary", () => {
  it("refuses a second workspace for one workstream", () => {
    const workstreamId = newWorkstreamId();
    const existing = makeWorkspace({ workstreamId });

    const check = checkWorkspaceBoundary({ workstreamId }, [existing]);

    expect(check).toMatchObject({
      allowed: false,
      refusal: { reason: "workstream_has_workspace" },
    });
  });

  it("allows one after the held workspace is removed", () => {
    const workstreamId = newWorkstreamId();
    const removed = makeWorkspace({ workstreamId, removedAt: NOW });

    expect(checkWorkspaceBoundary({ workstreamId }, [removed])).toEqual({
      allowed: true,
    });
  });

  it("allows a different workstream its own workspace", () => {
    const existing = makeWorkspace();

    expect(
      checkWorkspaceBoundary({ workstreamId: newWorkstreamId() }, [existing]),
    ).toEqual({ allowed: true });
  });
});

describe("checkRootOwnership", () => {
  it("refuses a path another workstream's workspace already owns", () => {
    const other = makeWorkspace({ roots: [root("/work/app")] });
    const mine = makeWorkspace();

    const check = checkRootOwnership(mine, [root("/work/app/")], [other]);

    expect(check).toMatchObject({
      allowed: false,
      refusal: {
        reason: "path_owned_by_other_workstream",
        heldBy: other.workstreamId,
      },
    });
  });

  it("refuses one workspace listing the same place twice", () => {
    const mine = makeWorkspace();

    const check = checkRootOwnership(
      mine,
      [root("/work/app", { key: "a" }), root("/work/app", { key: "b" })],
      [],
    );

    expect(check).toMatchObject({
      allowed: false,
      refusal: { reason: "duplicate_root" },
    });
  });

  it("ignores the workspace's own roots and removed workspaces", () => {
    const mine = makeWorkspace({ roots: [root("/work/app")] });
    const removed = makeWorkspace({
      roots: [root("/work/app")],
      removedAt: NOW,
    });

    expect(
      checkRootOwnership(mine, [root("/work/app")], [mine, removed]),
    ).toEqual({ allowed: true });
  });

  it("accepts distinct roots — a composite kind spans several (§13)", () => {
    const mine = makeWorkspace();

    expect(
      checkRootOwnership(
        mine,
        [
          root("/work/frontend", { key: "frontend" }),
          root("/work/backend", { key: "backend" }),
        ],
        [],
      ),
    ).toEqual({ allowed: true });
  });
});
