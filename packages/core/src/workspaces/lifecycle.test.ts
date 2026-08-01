import { describe, expect, it } from "vitest";

import { humanAuthor } from "../author.js";
import { newWorkstreamId } from "../ids.js";
import { newWorkspaceId } from "./ids.js";
import {
  GIT_WORKSPACE_KIND,
  type DiscoveredRepository,
  type RemovalOptions,
} from "./kind.js";
import {
  attachRequest,
  checkAttach,
  checkCreate,
  checkRemoval,
  type RemovalTarget,
} from "./lifecycle.js";
import { newWorkspaceRecord, type Workspace } from "./workspace.js";

const NOW = 1_700_000_000_000;
const FORCE: RemovalOptions = { force: true };
const NO_FORCE: RemovalOptions = { force: false };

const discovered: DiscoveredRepository = {
  kind: GIT_WORKSPACE_KIND,
  path: "/repos/app",
  name: "app",
  defaultBranch: "main",
  currentBranch: "main",
  remotes: [{ name: "origin", url: "git@github.com:acme/app.git" }],
  primaryCheckout: true,
};

function existingWorkspace(path: string): Workspace {
  const record = newWorkspaceRecord(
    {
      id: newWorkspaceId(),
      workstreamId: newWorkstreamId(),
      kind: GIT_WORKSPACE_KIND,
      config: {},
      createdBy: humanAuthor,
    },
    NOW,
  );
  return {
    ...record,
    roots: [
      { key: "root", path, branch: "feat/other", primaryCheckout: false },
    ],
  };
}

function target(overrides: Partial<RemovalTarget> = {}): RemovalTarget {
  return {
    root: {
      key: "root",
      path: "/work/app-feat-thing",
      branch: "feat/thing",
      primaryCheckout: false,
    },
    currentBranch: "feat/thing",
    defaultBranch: "main",
    uncommittedCount: 0,
    ...overrides,
  };
}

describe("discovered is not placed (principle 6)", () => {
  it("a discovered repository carries nothing that could place it", () => {
    const keys = Object.keys(discovered);

    expect(keys).not.toContain("workspaceId");
    expect(keys).not.toContain("workstreamId");
    expect(keys).not.toContain("nodeId");
    expect(keys).not.toContain("author");
    expect(keys).not.toContain("placed");
  });

  it("attaching one requires a workstream and an author — the gesture", () => {
    const workstreamId = newWorkstreamId();

    const request = attachRequest(discovered, {
      workspaceId: newWorkspaceId(),
      workstreamId,
      author: humanAuthor,
    });

    expect(request).toMatchObject({
      workstreamId,
      author: humanAuthor,
      kind: GIT_WORKSPACE_KIND,
    });
    expect(request.roots).toEqual([
      {
        key: "root",
        path: "/repos/app",
        branch: "main",
        primaryCheckout: true,
      },
    ]);
  });
});

describe("checkCreate / checkAttach", () => {
  it("refuses a second workspace for the workstream", () => {
    const existing = existingWorkspace("/work/other");
    const request = {
      workspaceId: newWorkspaceId(),
      workstreamId: existing.workstreamId,
      kind: GIT_WORKSPACE_KIND,
      config: {},
      author: humanAuthor,
    };

    expect(checkCreate(request, [existing])).toMatchObject({
      allowed: false,
      refusal: { reason: "workstream_has_workspace" },
    });
  });

  it("refuses attaching a path another workstream is working in", () => {
    const existing = existingWorkspace("/repos/app");

    const check = checkAttach(
      attachRequest(discovered, {
        workspaceId: newWorkspaceId(),
        workstreamId: newWorkstreamId(),
        author: humanAuthor,
      }),
      [existing],
    );

    expect(check).toMatchObject({
      allowed: false,
      refusal: { reason: "path_owned_by_other_workstream" },
    });
  });

  it("allows attaching a repository nobody is working in", () => {
    expect(
      checkAttach(
        attachRequest(discovered, {
          workspaceId: newWorkspaceId(),
          workstreamId: newWorkstreamId(),
          author: humanAuthor,
        }),
        [existingWorkspace("/work/elsewhere")],
      ),
    ).toEqual({ allowed: true });
  });
});

describe("checkRemoval", () => {
  it("removes a clean provisioned workspace", () => {
    expect(checkRemoval(target(), NO_FORCE)).toEqual({ allowed: true });
  });

  it("refuses removal with uncommitted changes until forced (§3.4)", () => {
    const dirty = target({ uncommittedCount: 3 });

    expect(checkRemoval(dirty, NO_FORCE)).toMatchObject({
      allowed: false,
      refusal: { reason: "uncommitted_changes", forcible: true },
    });
    expect(checkRemoval(dirty, FORCE)).toEqual({ allowed: true });
  });

  it("never removes the primary checkout, force or not (§3.4)", () => {
    const primary = target({
      root: {
        key: "root",
        path: "/repos/app",
        branch: "main",
        primaryCheckout: true,
      },
    });

    for (const options of [NO_FORCE, FORCE]) {
      expect(checkRemoval(primary, options)).toMatchObject({
        allowed: false,
        refusal: { reason: "primary_checkout", forcible: false },
      });
    }
  });

  it("never removes a workspace sitting on the default branch, force or not (§3.4)", () => {
    const onDefault = target({ currentBranch: "main", defaultBranch: "main" });

    for (const options of [NO_FORCE, FORCE]) {
      expect(checkRemoval(onDefault, options)).toMatchObject({
        allowed: false,
        refusal: { reason: "default_branch", forcible: false },
      });
    }
  });

  it("protects the primary checkout even when it is also dirty", () => {
    const both = target({
      root: {
        key: "root",
        path: "/repos/app",
        branch: "feat/thing",
        primaryCheckout: true,
      },
      uncommittedCount: 9,
    });

    expect(checkRemoval(both, FORCE)).toMatchObject({
      allowed: false,
      refusal: { reason: "primary_checkout" },
    });
  });
});
