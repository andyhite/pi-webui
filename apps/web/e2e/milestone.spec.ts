/**
 * THE W10 MILESTONE GATE (Epic 5.1/5.5, Batch 2 Stage 2, batch-blocking).
 *
 * Proves, end to end, against a real spawned server (`PLOTROOM_RUNTIME=
 * scripted`) and a real local git repository as the workstream's repo,
 * loaded as the server's own served page (single origin, spec §12) in a
 * real Chromium tab:
 *
 *   1. Dropping a command definition onto a bare ticket (a canvas gesture)
 *      creates a workstream and a command node, the ticket wired as its
 *      context (§3.5, one-gesture flow).
 *   2. Clicking "run" on that command node starts a run (idempotent
 *      initiation key, principle 9) and a session appears on the canvas.
 *   3. Opening the Conversation panel for that session streams the real
 *      observation-derived transcript live: reasoning rendered distinctly
 *      from output, and — after a first submission the declared world
 *      condition (`out.txt` must exist) fails, so PlotRoom's completion
 *      loop hands feedback back and the session continues into a second
 *      turn — a tool call with its input and output.
 *   4. The second attempt's tool call actually writes `out.txt`; the same
 *      condition now holds, so the run and the session both show proven
 *      completion — on the command node's own label and in the
 *      Conversation panel's status header.
 *
 * Run locally: `pnpm build && pnpm --filter @plotroom/web e2e` (root
 * `pnpm build` — or at least `@plotroom/core`, `@plotroom/ui`,
 * `@plotroom/server`, and `@plotroom/web` — must have already produced
 * `apps/server/dist` and `apps/web/dist`; this suite spawns the former and
 * serves the latter, neither of which exists until built).
 *
 * Deferred to later batches (noted, not asserted here): composer send is
 * disabled with a reason (injection has no server endpoint yet, Batch 3);
 * drafts/prompt history are exercised at the unit level only.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  apiPost,
  startMilestoneServer,
  type MilestoneServer,
} from "./server-harness.js";

let server: MilestoneServer;

test.beforeAll(async () => {
  server = await startMilestoneServer();
});

test.afterAll(async () => {
  await server.stop();
});

/**
 * Real HTML5 drag-and-drop, dispatched directly with a real `DataTransfer`
 * so headless Chromium runs the same `dataTransfer.setData`/`getData` path
 * a human drag would — Playwright's mouse-based `dragTo` does not reliably
 * drive React's own `onDragStart`/`onDrop` handlers for a custom-typed
 * HTML5 drag payload the way this canvas uses (`PlotCanvas.tsx`'s
 * `COMMAND_DEFINITION_DRAG_TYPE`). `source`/`target` are handed to the page
 * as real DOM elements (Playwright resolves `Locator`s passed into
 * `page.evaluate`), so no extra `data-testid` is needed on the drag
 * source — only the drop target, which already carries one for exactly
 * this purpose.
 */
async function dragAndDropHtml5(
  page: Page,
  source: Locator,
  target: Locator,
): Promise<void> {
  const sourceHandle = await source.elementHandle();
  const targetHandle = await target.elementHandle();
  if (!sourceHandle || !targetHandle) {
    throw new Error("drag source/target did not resolve to a DOM element");
  }

  await page.evaluate(
    ([sourceEl, targetEl]) => {
      const dataTransfer = new DataTransfer();
      const dispatch = (el: Element, type: string) =>
        el.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer,
          }),
        );
      dispatch(sourceEl as Element, "dragstart");
      dispatch(targetEl as Element, "dragenter");
      dispatch(targetEl as Element, "dragover");
      dispatch(targetEl as Element, "drop");
      dispatch(sourceEl as Element, "dragend");
    },
    [sourceHandle, targetHandle] as const,
  );
}

/**
 * `fitView`'s computed zoom depends on the node bounding box vs. viewport
 * size, which this test does not control precisely enough to predict —
 * but the workstream zoom level force-collapses containers (hiding the
 * command/session nodes this test needs to click), so it zooms in with the
 * canvas's own wheel-zoom interaction until the (test-only) zoom-level hook
 * reports anything other than "workstream", with proper waits, no sleeps.
 */
async function ensureNotCollapsed(page: Page): Promise<void> {
  const zoomLevel = page.getByTestId("zoom-level");
  const pane = page.locator(".react-flow__pane");
  for (let attempt = 0; attempt < 20; attempt++) {
    if ((await zoomLevel.textContent()) !== "workstream") return;
    await pane.hover();
    await page.mouse.wheel(0, -400);
  }
  await expect(zoomLevel).not.toHaveText("workstream");
}

test("drop a command definition onto a ticket, run it, watch the transcript stream live, see proven completion", async ({
  page,
}) => {
  const base = server.baseUrl;

  // Seed a bare ticket and a producing command definition with a real
  // world condition — everything after this is the canvas gesture the
  // gate exists to prove; nothing here creates the workstream or the
  // command node themselves.
  const ticketObject = await apiPost<{ object: { id: string } }>(
    base,
    "/api/objects",
    {
      kind: "ticket",
      title: "OXY-9001 write the output file",
      renderings: {
        card: {},
        summary: "OXY-9001",
        agentContent: "write out.txt",
      },
    },
  );
  const ticketNode = await apiPost<{ node: { id: string } }>(
    base,
    "/api/nodes",
    { role: "content", refId: ticketObject.object.id },
  );
  const definitionName = "Write the output file";
  await apiPost(base, "/api/command-definitions", {
    name: definitionName,
    instruction: "Write out.txt in the workspace.",
    model: "e2e-fixture-model",
    effort: "low",
    lifecycle: "producing",
    outcome: {
      name: "result",
      kind: "document",
      conditions: [
        {
          id: "output_written",
          predicate: "workspace_file_exists",
          description: "the workspace contains out.txt",
          args: { path: "out.txt" },
        },
      ],
    },
  });

  await page.goto(`${base}/`);
  await ensureNotCollapsed(page);

  const ticketLocator = page.getByTestId(`canvas-node-${ticketNode.node.id}`);
  await expect(ticketLocator).toBeVisible();

  const paletteEntry = page.getByText(`command definition: ${definitionName}`);
  await expect(paletteEntry).toBeVisible();

  // Step 1: the one-gesture flow — dropping a command definition onto a
  // bare ticket creates a workstream and a command node, the ticket wired
  // as its context (§3.5).
  await dragAndDropHtml5(page, paletteEntry, ticketLocator);

  const commandNode = page.locator('[data-testid^="canvas-node-"]', {
    hasText: `command: ${definitionName}`,
  });
  await expect(commandNode).toBeVisible();
  await ensureNotCollapsed(page);

  // Step 2: run it. A fresh initiation key per click (principle 9); the
  // canvas surfaces refusal reasons rather than swallowing them, but a
  // freshly provisioned workspace against a real repo should not refuse.
  // A direct DOM `.click()`, not Playwright's coordinate-based one — see
  // the session node click below for why.
  await commandNode
    .getByRole("button", { name: "run" })
    .evaluate((el) => (el as HTMLElement).click());

  const sessionNode = page.locator('[data-testid^="canvas-node-"]', {
    hasText: /^session sess_/,
  });
  await expect(sessionNode).toBeVisible();
  await ensureNotCollapsed(page);

  // Step 3: open its Conversation panel and watch the observation-derived
  // transcript stream live. A direct DOM `.click()` rather than Playwright's
  // coordinate-based click: an unstyled, undesigned canvas layout (design
  // gate, fleet rule 5) can genuinely overlap sibling nodes on screen, and
  // this must click *this* node, never whatever happens to be on top of it
  // at that point.
  await sessionNode.evaluate((el) => (el as HTMLElement).click());
  await page.getByRole("button", { name: "Conversation" }).click();

  const conversationStatus = page.getByRole("status").filter({
    hasText: "phase:",
  });
  await expect(conversationStatus).toBeVisible();

  // Composer send is honestly disabled — injection has no server endpoint
  // yet (§6.5, Batch 3 scope).
  await expect(page.getByTestId("send-disabled-reason")).toBeVisible();

  // Turn 1: reasoning rendered distinctly from output.
  await expect(
    page.locator('[data-transcript-kind="reasoning"]').first(),
  ).toContainText("checking whether out.txt already exists");
  await expect(
    page.locator('[data-transcript-kind="output"]').first(),
  ).toContainText("I believe the work is already done.");

  // The first submission fails the declared condition; PlotRoom hands the
  // feedback back and the session continues into a second turn — proof the
  // completion loop is a loop, not a single answer.
  await expect(
    page.locator('[data-transcript-kind="reasoning"]').nth(1),
  ).toContainText("the feedback says out.txt is missing", { timeout: 20_000 });

  // Turn 2's tool call, with its input and output — distinct from the
  // `plotroom_submit_outcome` tool call every attempt also makes.
  const toolCall = page.locator('[data-transcript-kind="tool-call"]', {
    hasText: "write_file",
  });
  await expect(toolCall).toBeVisible();
  await toolCall.locator("summary").click();
  await expect(toolCall).toContainText("wrote out.txt");

  // Step 4: proven completion — on the session (Conversation panel) and on
  // the command node itself.
  await expect(page.getByTestId("session-end")).toHaveText("end: completed", {
    timeout: 20_000,
  });
  await expect(commandNode).toContainText("run: completed");
});
