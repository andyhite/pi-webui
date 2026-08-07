/**
 * ZOOM-LEVEL SEMANTICS AND COLLAPSED CONTAINERS (Epic 8.5, Epic 3.2, spec
 * §5).
 *
 * Proves, end to end, against a real spawned server and a real Chromium
 * tab loaded from the server's own served page (single origin, §12):
 *
 *   (a) Zoomed out (`workstream`): a workstream container force-collapses
 *       to one card — the command node it contains is never rendered at
 *       all.
 *   (b) Zoomed to `inner`: the container expands, the command node
 *       renders again, and it shows its id — but not yet its role, which
 *       is reserved for full detail.
 *   (c) Zoomed to `detail`: the same node now also shows its role.
 *   (d) Zooming back out re-collapses the container and re-hides the node,
 *       exactly as it did the first time — the manual/zoom collapse forces
 *       compose rather than the manual choice getting stuck once overridden.
 *
 * KNOWN REGRESSION, DELIBERATELY NOT ASSERTED HERE: §5/§3.3's other claim
 * for this epic — "edges into a collapsed container draw to its frame" —
 * does not currently hold. `remapEdgesForCollapse`
 * (`packages/ui/src/containers/collapse.ts`) correctly remaps an edge's
 * endpoint to the container's own id, but `ContainerNodeView`
 * (`packages/ui/src/canvas/PlotCanvas.tsx`) renders no `<Handle>` elements
 * at all, so xyflow's own edge-position resolver has nothing to anchor a
 * connection to and the edge silently never renders once its target
 * collapses — confirmed directly (wire a ticket into a command, collapse
 * the container, the edge disappears from the DOM entirely) while writing
 * this file. This is a `packages/ui` production-code fix (add `Handle`s to
 * `ContainerNodeView`) outside this batch's file ownership; asserting the
 * current, broken behavior here would enshrine the bug as a green test, so
 * that assertion is deliberately absent rather than present-and-wrong. The
 * fix and its own render-level e2e proof are tracked separately, against
 * Epic 3.2's own claim.
 *
 * `zoomLevelForScale`'s thresholds (0.6 for `inner`, 1.2 for `detail`,
 * `packages/ui/src/zoom/level.ts`) are read through the canvas's own
 * (test-only) `zoom-level` hook — `fitView`'s computed initial zoom is not
 * something a test can predict, so every level here is reached by the
 * canvas's real wheel-zoom interaction, checked after every step rather
 * than assumed from a fixed scroll amount.
 */
import { expect, test, type Page } from "@playwright/test";

import {
  apiPost,
  startMilestoneServer,
  stopOnTeardown,
  type MilestoneServer,
} from "./server-harness.js";

let server: MilestoneServer | undefined;

test.beforeAll(async () => {
  server = await startMilestoneServer();
});

stopOnTeardown(() => server);

function requireServer(): MilestoneServer {
  if (!server) {
    throw new Error(
      "the zoom/containers server never started (beforeAll failed)",
    );
  }
  return server;
}

/**
 * Steps the real wheel-zoom interaction one small tick at a time, checking
 * the (test-only) `zoom-level` hook after every tick, until it satisfies
 * `predicate` — never a fixed jump that might skip straight past the level
 * being asserted (e.g. `workstream` all the way to `detail` in one step).
 */
async function zoomStepUntil(
  page: Page,
  predicate: (level: string) => boolean,
  wheelDeltaY: number,
  maxSteps = 80,
): Promise<void> {
  const zoomLevel = page.getByTestId("zoom-level");
  const pane = page.locator(".react-flow__pane");
  await pane.hover();
  for (let attempt = 0; attempt < maxSteps; attempt++) {
    const text = (await zoomLevel.textContent()) ?? "";
    if (predicate(text)) return;
    await page.mouse.wheel(0, wheelDeltaY);
  }
  const finalText = (await zoomLevel.textContent()) ?? "<unreadable>";
  throw new Error(
    `zoom level never satisfied the predicate within ${maxSteps} steps (last seen: "${finalText}")`,
  );
}

async function zoomAllTheWayOut(page: Page): Promise<void> {
  await zoomStepUntil(page, (level) => level === "workstream", 200, 30);
  await expect(page.getByTestId("zoom-level")).toHaveText("workstream");
}

test("zoom switches node renderers (workstream card -> inner nodes -> full detail), and collapsing re-hides/re-shows the contained node each time", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const base = requireServer().baseUrl;

  const workstream = await apiPost<{ workstream: { id: string } }>(
    base,
    "/api/workstreams",
    {},
  );
  const workstreamId = workstream.workstream.id;

  const definition = await apiPost<{ definition: { id: string } }>(
    base,
    "/api/command-definitions",
    {
      name: "zoom containers command",
      instruction: "stand in for whatever this test's script does",
      model: "e2e-fixture-model",
      effort: "low",
      lifecycle: "open",
    },
  );
  const command = await apiPost<{
    command: { id: string };
    node: { id: string };
  }>(base, "/api/commands", {
    definitionId: definition.definition.id,
    workstreamId,
  });
  const commandNodeId = command.node.id;

  const ticketObject = await apiPost<{ object: { id: string } }>(
    base,
    "/api/objects",
    {
      kind: "ticket",
      title: "Zoom containers ticket",
      renderings: {
        card: {},
        summary: "Zoom containers ticket",
        agentContent: "context for the zoom containers gate",
      },
    },
  );
  const ticketNode = await apiPost<{ node: { id: string } }>(
    base,
    "/api/nodes",
    { role: "content", refId: ticketObject.object.id },
  );
  const ticketNodeId = ticketNode.node.id;

  await apiPost(base, "/api/edges", { from: ticketNodeId, to: commandNodeId });

  await page.goto(`${base}/`);
  await expect(page.getByTestId(`canvas-node-${ticketNodeId}`)).toBeVisible();

  // -------------------------------------------------------------- workstream
  await zoomAllTheWayOut(page);

  const containerFrame = page.locator(
    `[data-testid="rf__node-${workstreamId}"]`,
  );
  await expect(containerFrame).toBeVisible();

  // The container's own child never renders at all while collapsed — not
  // hidden by CSS, absent from the DOM (`node.hidden` short-circuits xyflow's
  // own node renderer).
  const commandLocator = page.locator(
    `[data-testid="canvas-node-${commandNodeId}"]`,
  );
  await expect(commandLocator).toHaveCount(0);

  // ------------------------------------------------------------------ inner
  await zoomStepUntil(page, (level) => level === "inner", -40);
  await expect(page.getByTestId("zoom-level")).toHaveText("inner");

  const commandNode = page.getByTestId(`canvas-node-${commandNodeId}`);
  await expect(commandNode).toBeVisible();
  await expect(commandNode).toContainText(`id: ${commandNodeId}`);
  // Full detail (role, running state) is reserved for the `detail` level —
  // not shown yet at `inner`.
  await expect(commandNode).not.toContainText("role: command");

  // ----------------------------------------------------------------- detail
  await zoomStepUntil(page, (level) => level === "detail", -40);
  await expect(page.getByTestId("zoom-level")).toHaveText("detail");
  await expect(commandNode).toContainText("role: command");

  // ------------------------------------------------------ back to workstream
  await zoomAllTheWayOut(page);
  await expect(commandLocator).toHaveCount(0);
  await expect(containerFrame).toBeVisible();
});
