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
 *   3. Opening the Conversation panel *before* turn 1 has said anything —
 *      the scripted session paces itself with real delays
 *      (`server-harness.ts`'s `MILESTONE_SCRIPT`) specifically so this test
 *      opens the panel while nothing has arrived yet — and watching the
 *      real observation-derived transcript stream in live over `/ws`:
 *      reasoning rendered distinctly from output, neither present in the
 *      panel's first paint; then, after a first submission the declared
 *      world condition (`out.txt` must exist) fails, so PlotRoom's
 *      completion loop hands feedback back and the session continues into
 *      a second turn — proven absent right up until then, and then a tool
 *      call with its input and output, again arriving with no reload or
 *      refetch this test triggers itself.
 *   4. The second attempt's tool call actually writes `out.txt`; the same
 *      condition now holds, so the run and the session both show proven
 *      completion — on the command node's own label and in the
 *      Conversation panel's status header.
 *
 * A prior version of this gate opened the panel only after the whole
 * scripted session had already finished (no pacing), so every assertion
 * passed off `subscribeTranscript`'s one-time initial refetch alone —
 * deleting the live `/ws` observation-handling branch entirely still
 * passed. This version does not: verified by temporarily deleting the
 * `session_observation`/`session_transcript` branch of `applyBufferedEvent`
 * in `packages/ui/src/sessions/data-source.ts` and re-running (the turn-1
 * reasoning/output and turn-2 assertions below time out, since nothing
 * after the initial empty paint is ever refetched), then restoring it.
 *
 * Run locally: `turbo run build --filter=@plotroom/web && bun run --filter=@plotroom/web e2e`
 * (`apps/web/dist` must already exist; this suite serves it. #315: `apps/server`
 * no longer builds — the spawned server entry is `apps/server/src/index.ts`
 * directly, via `bun`).
 *
 * Deferred to later batches (noted, not asserted here): drafts/prompt
 * history are exercised at the unit level only. Composer send (injection,
 * §6.5) went live in Batch 3, Stage 2 and is exercised end to end by its
 * own gate, `steering.spec.ts` (the W14 milestone).
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

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

// Review finding n6: Playwright still runs afterAll when beforeAll threw, so
// an unguarded `server.stop()` would crash on `undefined` and bury the real
// failure reason under a second, unrelated one. `startMilestoneServer`
// itself now tears down whatever it already created before rethrowing (see
// its own doc comment), so there is nothing left to leak either way —
// `stopOnTeardown` only ever calls `stop()` when `server` was actually set.
stopOnTeardown(() => server);

function requireServer(): MilestoneServer {
  if (!server) {
    throw new Error("the milestone server never started (beforeAll failed)");
  }
  return server;
}

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
  const base = requireServer().baseUrl;

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

  // THE LIVE-STREAMING PROOF (gate review finding: this must not pass just
  // because the whole session finished before the panel ever opened). The
  // scripted session paces turn 1 with real delays (server-harness.ts), so
  // the panel opens seconds before turn 2 can possibly exist: turn 2 needs
  // turn 1 to finish, a submission, and PlotRoom's completion loop to send
  // feedback back — none of which has happened yet. This absence is the
  // baseline a genuine live update has to depart from; if it never departs
  // from it (the WS observation/transcript branch broken), every assertion
  // below times out instead of passing for the wrong reason.
  const turn2Reasoning = page.locator('[data-transcript-kind="reasoning"]', {
    hasText: "the feedback says out.txt is missing",
  });
  await expect(turn2Reasoning).toHaveCount(0);

  // Turn 1: reasoning rendered distinctly from output, arriving live —
  // neither is in the panel's very first (already-asserted-empty-of-turn-2)
  // paint; both appear only once the scripted delay ahead of each elapses
  // and the server publishes the observation over /ws.
  await expect(
    page.locator('[data-transcript-kind="reasoning"]').first(),
  ).toContainText("checking whether out.txt already exists", {
    timeout: 10_000,
  });
  await expect(
    page.locator('[data-transcript-kind="output"]').first(),
  ).toContainText("I believe the work is already done.", { timeout: 10_000 });

  // Still true right up to turn 1 finishing: turn 2 cannot exist until a
  // submission is checked and feedback comes back.
  await expect(turn2Reasoning).toHaveCount(0);

  // The first submission fails the declared condition; PlotRoom hands the
  // feedback back and the session continues into a second turn — proof the
  // completion loop is a loop, not a single answer, and that it arrived over
  // /ws, not from any reload or refetch this test triggers itself.
  await expect(turn2Reasoning).toBeVisible({ timeout: 20_000 });

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
