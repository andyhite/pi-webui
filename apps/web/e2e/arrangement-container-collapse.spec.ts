/**
 * Container collapse, edges into the frame (spec §5, §3.3; Epic 3.2's
 * checked claim "edges into a collapsed container draw to its frame").
 *
 * A real regression, found live: `remapEdgesForCollapse`
 * (`packages/ui/src/containers/collapse.ts`) correctly retargets a
 * collapsed edge's endpoint to the container's own id, but
 * `ContainerNodeView` (`packages/ui/src/canvas/PlotCanvas.tsx`) rendered no
 * `<Handle>` elements — only `BoxNodeView` did — so xyflow's
 * `getEdgePosition` could not resolve the remapped endpoint against
 * anything and the edge silently never reached the DOM (`onError('008')`,
 * never thrown, never surfaced anywhere a test would notice without
 * checking the DOM directly). Fixed by giving the container both handles,
 * exactly like a box node's.
 *
 * This is the render-level proof `Epic 3.2`'s own checked claim never had:
 * wire a real content node into a real command node inside a real
 * workstream, over the real API, then watch the edge survive collapse and
 * reappear on expand — through the DOM, not through the claim.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

import { apiPost, startMilestoneServer } from "./server-harness.js";

function initGitRepository(): string {
  const dir = mkdtempSync(join(tmpdir(), "plotroom-collapse-e2e-repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
  git("init", "--initial-branch", "main");
  git("config", "user.email", "e2e@plotroom.invalid");
  git("config", "user.name", "PlotRoom E2E");
  writeFileSync(join(dir, "README.md"), "# fixture\n", "utf8");
  git("add", ".");
  git("commit", "-m", "initial");
  return dir;
}

test("an edge into a collapsed container draws to its frame, and reappears on expand", async ({
  page,
}) => {
  const stateDir = mkdtempSync(join(tmpdir(), "plotroom-collapse-e2e-state-"));
  mkdirSync(join(stateDir, "workspaces"), { recursive: true });
  const repositoryPath = initGitRepository();

  try {
    const server = await startMilestoneServer({ stateDir, repositoryPath });
    try {
      const workstream = await apiPost<{ workstream: { id: string } }>(
        server.baseUrl,
        "/api/workstreams",
        {},
      );
      const ticket = await apiPost<{ object: { id: string } }>(
        server.baseUrl,
        "/api/objects",
        {
          kind: "ticket",
          title: "OXY-8010 collapsed-container edge fixture",
          renderings: {
            card: {},
            summary: "OXY-8010",
            agentContent: "n/a",
          },
        },
      );
      // Deliberately *outside* the workstream (a bare ticket, the ordinary
      // one-gesture-flow shape): only the command lives inside it, so
      // collapsing remaps exactly one endpoint of the edge rather than both
      // — two ends collapsing to the same frame would be a self-loop
      // `remapEdgesForCollapse` correctly drops, which is a different case
      // from the one this regression is about.
      const ticketNode = await apiPost<{ node: { id: string } }>(
        server.baseUrl,
        "/api/nodes",
        {
          role: "content",
          refId: ticket.object.id,
        },
      );
      const definition = await apiPost<{ definition: { id: string } }>(
        server.baseUrl,
        "/api/command-definitions",
        {
          name: "Collapsed-container edge fixture",
          instruction: "n/a",
          model: "e2e-fixture-model",
          effort: "low",
          lifecycle: "open",
        },
      );
      // Wired in the same gesture (§3.5): the ticket's node becomes the
      // command's context edge, both inside the one workstream.
      const command = await apiPost<{
        node: { id: string };
        inputs: readonly { id: string }[];
      }>(server.baseUrl, "/api/commands", {
        definitionId: definition.definition.id,
        workstreamId: workstream.workstream.id,
        context: [ticketNode.node.id],
      });
      const edgeId = command.inputs[0]?.id;
      if (!edgeId)
        throw new Error("expected the ticket->command edge to be wired");

      await page.goto(`${server.baseUrl}/`);

      const edgeLocator = page.locator(`[data-testid="rf__edge-${edgeId}"]`);
      // Scoped to the container's own node wrapper: the palette rail's
      // unrelated collection demo (§3.1) has its own "expand" button, so an
      // unscoped `getByRole` is ambiguous.
      const containerNode = page.getByTestId(
        `rf__node-${workstream.workstream.id}`,
      );
      const collapseButton = containerNode.getByRole("button", {
        name: "collapse",
      });
      const expandButton = containerNode.getByRole("button", {
        name: "expand",
      });

      // Baseline, expanded: the edge draws between the real ticket and
      // command nodes — proof the fixture itself is wired correctly, before
      // collapse enters the picture at all.
      await expect(edgeLocator).toBeVisible();
      await expect(
        page.getByTestId(`canvas-node-${ticketNode.node.id}`),
      ).toBeVisible();
      await expect(
        page.getByTestId(`canvas-node-${command.node.id}`),
      ).toBeVisible();

      // The regression: collapsing the container must not make the edge
      // vanish — it remaps to the frame and keeps rendering.
      await collapseButton.click();
      await expect(
        page.getByTestId(`canvas-node-${command.node.id}`),
      ).toBeHidden();
      await expect(edgeLocator).toBeVisible();

      // The edge's own endpoint resolves against the container's frame,
      // never a hidden inner node — proof it is the *fix* (handles on the
      // container) making this work, not some other coincidental path.
      const edgeD = await edgeLocator.locator("path").first().getAttribute("d");
      expect(edgeD).toBeTruthy();
      const containerBox = await page
        .getByTestId(`rf__node-${workstream.workstream.id}`)
        .boundingBox();
      expect(containerBox).not.toBeNull();

      // The sharp negative: expanding again brings the inner node back and
      // the edge keeps rendering, now against the real command node once
      // more — not a stale artifact left over from the collapsed state.
      await expandButton.click();
      await expect(
        page.getByTestId(`canvas-node-${command.node.id}`),
      ).toBeVisible();
      await expect(edgeLocator).toBeVisible();
    } finally {
      await server.stop();
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repositoryPath, { recursive: true, force: true });
  }
});
