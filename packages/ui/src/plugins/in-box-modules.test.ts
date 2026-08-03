import { describe, expect, it } from "vitest";

import {
  IN_BOX_PLUGIN_MODULES,
  createInBoxContributionRegistry,
} from "./in-box-modules.js";
import { resolveCardView } from "./contribution-registry.js";
import { createRendererCallContext } from "./call-context.js";

describe("IN_BOX_PLUGIN_MODULES", () => {
  it("carries the Filesystem plugin (Track B's Stage 2, §9.4)", () => {
    const filesystem = IN_BOX_PLUGIN_MODULES.find(
      (module) => module.pluginId === "filesystem",
    );
    expect(filesystem).toBeDefined();
    expect(filesystem?.manifest.id).toBe("filesystem");
    expect(filesystem?.manifest.contractVersion).toBe(1);
  });

  it("carries the Coding/git plugin (Track C's Epic 7.3 port, this batch's final wave)", () => {
    const git = IN_BOX_PLUGIN_MODULES.find(
      (module) => module.pluginId === "coding-git",
    );
    expect(git).toBeDefined();
    expect(git?.manifest.id).toBe("coding-git");
    expect(git?.manifest.contractVersion).toBe(1);
  });

  it("carries the GitHub plugin (Track C's Epic 7.3 port, this batch's final wave)", () => {
    const github = IN_BOX_PLUGIN_MODULES.find(
      (module) => module.pluginId === "github",
    );
    expect(github).toBeDefined();
    expect(github?.manifest.id).toBe("github");
    expect(github?.manifest.contractVersion).toBe(1);
  });

  it("registers pluginId consistent with each manifest's own id", () => {
    for (const module of IN_BOX_PLUGIN_MODULES) {
      expect(module.pluginId).toBe(module.manifest.id);
    }
  });
});

describe("createInBoxContributionRegistry", () => {
  it("seeds a registry that resolves Filesystem's card and palette entry — the browse/drag surface", async () => {
    const registry = createInBoxContributionRegistry();

    expect(registry.cardRendererFor("document")).toBeDefined();

    const paletteIds = registry.paletteEntries().map((entry) => entry.id);
    expect(paletteIds).toContain("browse");

    const view = await resolveCardView(
      registry,
      {
        kind: "document",
        externalId: "/tmp/example.txt",
        title: "example.txt",
        renderings: {
          card: JSON.stringify({
            fsKind: "file",
            sizeBytes: 3,
            truncated: null,
          }),
          summary: "file · 3 bytes",
          agentContent: "hi\n",
        },
      },
      "compact",
    );
    expect(view?.title).toContain("file");
    expect(view?.actions).toEqual([]);
  });

  it("resolves the Coding/git card renderer for both concept kinds it declares (diff, commit)", async () => {
    const registry = createInBoxContributionRegistry();

    expect(registry.cardRendererFor("diff")).toBeDefined();
    expect(registry.cardRendererFor("commit")).toBeDefined();

    const view = await resolveCardView(
      registry,
      {
        kind: "diff",
        externalId: "/tmp/repo",
        title: "Workspace diff",
        renderings: {
          card: "2 files changed",
          summary: "2 files changed",
          agentContent: "- modified: src/index.ts",
        },
      },
      "compact",
    );
    expect(view?.title).toBe("Workspace diff");
    expect(view?.lines).toEqual(["2 files changed"]);
  });

  it("resolves the GitHub card renderer for every concept kind it declares (pull_request, review, ticket, document) and its palette entry", async () => {
    const registry = createInBoxContributionRegistry();

    for (const kind of [
      "pull_request",
      "review",
      "ticket",
      "document",
    ] as const) {
      expect(registry.cardRendererFor(kind)).toBeDefined();
    }

    const paletteIds = registry.paletteEntries().map((entry) => entry.id);
    expect(paletteIds).toContain("github-clone-from-pull-request");

    const view = await resolveCardView(
      registry,
      {
        kind: "pull_request",
        externalId: "42",
        title: "Example pull request",
        renderings: {
          card: "open · 3 commits",
          summary: "open · 3 commits",
          agentContent: "Clone: https://example.invalid/repo.git",
        },
      },
      "compact",
    );
    expect(view?.title).toBe("Example pull request");
    // The clone-from-pull-request card action, offered with no write action
    // behind it (§3.4: the clone is the host's git, never this plugin's).
    expect(view?.actions).toEqual([
      {
        id: "clone-from-pull-request",
        label: "Clone this repository",
        writeActionId: null,
      },
    ]);
  });

  it("surfaces truncation as a fact through GitHub's content renderer, never silently (principle 12)", async () => {
    const registry = createInBoxContributionRegistry();
    const renderer = registry.contentRendererFor("pull_request");
    expect(renderer).toBeDefined();

    const oversized = "x".repeat(70 * 1024);
    const rendered = await renderer?.renderAgentContent(
      {
        kind: "pull_request",
        externalId: "42",
        title: "Example pull request",
        renderings: {
          card: "open",
          summary: "open",
          agentContent: oversized,
        },
      },
      createRendererCallContext(),
    );
    expect(rendered?.truncated).not.toBeNull();
    expect(rendered?.truncated?.omittedBytes).toBeGreaterThan(0);
    expect(rendered?.content.length).toBeLessThan(oversized.length);
  });

  it("surfaces truncation as a fact through Coding/git's content renderer too (principle 12)", async () => {
    const registry = createInBoxContributionRegistry();
    const renderer = registry.contentRendererFor("diff");
    expect(renderer).toBeDefined();

    const oversized = "x".repeat(100 * 1024);
    const rendered = await renderer?.renderAgentContent(
      {
        kind: "diff",
        externalId: "/tmp/repo",
        title: "Workspace diff",
        renderings: {
          card: "1 file changed",
          summary: "1 file changed",
          agentContent: oversized,
        },
      },
      createRendererCallContext(),
    );
    expect(rendered?.truncated).not.toBeNull();
    expect(rendered?.truncated?.omittedBytes).toBeGreaterThan(0);
  });
});
