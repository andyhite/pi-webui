/**
 * THE KEYBOARD AND ACCESSIBILITY GATE (Epic 8.1, §11).
 *
 * Proves, end to end, against a real spawned server (`PLOTROOM_RUNTIME=
 * scripted`) and a real local git repository, loaded as the server's own
 * served page (single origin, spec §12) in a real Chromium tab:
 *
 *   (a) **The overlay is the registry.** `?` opens the shortcuts overlay and
 *       it lists a binding from every scope that has one — a global verb, a
 *       canvas verb, the palette's own toggle, and a key xyflow (not this
 *       codebase) implements. Nothing in the overlay is written down twice:
 *       it renders `useRegisteredBindings()`, so a row exists exactly because
 *       a binding was registered ("a binding cannot exist undocumented").
 *   (b) **Dialogs trap and restore focus.** With the overlay open, focus is
 *       inside it and repeated Tabs never leave; Escape closes it and focus
 *       returns to the element that had it before it opened.
 *   (c) **The high-frequency verbs, from the keyboard only.** A canvas node is
 *       reached by focus, selected with Enter (selection is the route, §5),
 *       run with `R`, and the session it produced is stopped with `S` — no
 *       mouse click at any point, and the run/stop that result are the same
 *       gestures the buttons call.
 *   (d) **The queue answers with nothing open.** A scripted question reaches
 *       the queue; `J` moves the (host-held) cursor onto it and `1` answers it
 *       with its first option, with the Queue panel never opened at all —
 *       which is the point of §11's "keyboard access to the verbs".
 *   (e) **Streaming announces on start and completion, never per token.** The
 *       Conversation panel's live region says "response started" while turn 1
 *       is still streaming and "response complete" afterward, and never
 *       contains a fragment of the transcript itself.
 *   (f) **A documented key is a real key.** Both chords the overlay lists for
 *       the canvas delete — `Backspace` *and* `Delete`, which xyflow's default
 *       `deleteKeyCode` does not include — actually delete the focused node,
 *       and the gesture is one undo away from being back.
 *
 * Run locally: `bun run build && bun run --filter=@plotroom/web e2e` (root
 * `bun run build` — or at least `@plotroom/core`, `@plotroom/ui`,
 * `@plotroom/server`, and `@plotroom/web` — must have already produced
 * `apps/server/dist` and `apps/web/dist`).
 */
import { expect, test, type Page } from "@playwright/test";

import {
  apiGet,
  apiPost,
  startMilestoneServer,
  type MilestoneServer,
} from "./server-harness.js";

let server: MilestoneServer | undefined;

test.beforeAll(async () => {
  server = await startMilestoneServer({ concurrencyLimit: 8 });
});

test.afterAll(async () => {
  if (server) await server.stop();
});

function requireServer(): MilestoneServer {
  if (!server) {
    throw new Error("the a11y gate's server never started (beforeAll failed)");
  }
  return server;
}

/**
 * `fitView`'s computed zoom is not predictable from a test, and the workstream
 * zoom level force-collapses containers (hiding the nodes these tests reach by
 * keyboard) — so zoom in with the canvas's own interaction until the
 * (test-only) zoom-level hook reports anything else. Waits, never sleeps.
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

async function createDefinition(base: string, name: string): Promise<string> {
  const definition = await apiPost<{ definition: { id: string } }>(
    base,
    "/api/command-definitions",
    {
      name,
      instruction: "stand in for whatever this test's script does",
      model: "e2e-fixture-model",
      effort: "low",
      lifecycle: "open",
    },
  );
  return definition.definition.id;
}

async function createCommandNode(
  base: string,
  name: string,
): Promise<{ readonly commandId: string; readonly nodeId: string }> {
  const definitionId = await createDefinition(base, name);
  const workstream = await apiPost<{ workstream: { id: string } }>(
    base,
    "/api/workstreams",
    {},
  );
  const command = await apiPost<{
    command: { id: string };
    node: { id: string };
  }>(base, "/api/commands", {
    definitionId,
    workstreamId: workstream.workstream.id,
  });
  return { commandId: command.command.id, nodeId: command.node.id };
}

/** The id of whatever xyflow node currently has focus, or null. */
async function focusedNodeId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const active = document.activeElement;
    const wrapper = active?.closest(".react-flow__node") ?? null;
    return wrapper?.getAttribute("data-id") ?? null;
  });
}

/**
 * Focuses a canvas node the way a keyboard reaches it — the node wrapper is
 * tabbable because xyflow renders nodes as real DOM (AGENTS.md's canvas
 * notes), so this only has to put focus on it, never click it.
 */
async function focusCanvasNode(page: Page, nodeId: string): Promise<void> {
  await page
    .locator(`.react-flow__node[data-id="${nodeId}"]`)
    .evaluate((element) => (element as HTMLElement).focus());
  await expect.poll(() => focusedNodeId(page)).toBe(nodeId);
}

test.describe("the keyboard and accessibility gate", () => {
  test("the shortcuts overlay is the binding registry, and traps and restores focus", async ({
    page,
  }) => {
    const base = requireServer().baseUrl;
    await page.goto(`${base}/`);
    await expect(page.getByTestId("attention-header-count")).toBeVisible();

    // Focus something specific first, so "restores focus" is a claim about an
    // element rather than about the document.
    const queuePanelButton = page.getByRole("button", {
      name: "Queue",
      exact: true,
    });
    await queuePanelButton.focus();
    await expect(queuePanelButton).toBeFocused();

    await page.keyboard.press("?");

    const overlay = page.getByTestId("shortcuts-overlay");
    await expect(overlay).toBeVisible();

    // A binding from each scope that has one — every row exists because the
    // binding is registered, not because this list was written twice.
    await expect(
      page.getByTestId("shortcut-verb-run-selected-node"),
    ).toContainText("run the selected node");
    await expect(
      page.getByTestId("shortcut-verb-stop-selected-session"),
    ).toContainText("stop the selected session");
    await expect(page.getByTestId("shortcut-verb-queue-next")).toContainText(
      "next attention item",
    );
    await expect(
      page.getByTestId("shortcut-command-palette-open"),
    ).toContainText("command palette");
    await expect(
      page.getByTestId("shortcut-canvas-wire-context"),
    ).toBeVisible();
    // A queue binding, listed while the Queue panel is *closed* — the queue's
    // keys are the host's for exactly this reason (§11).
    await expect(page.getByTestId("attention-queue")).toHaveCount(0);
    await expect(
      page.getByTestId("shortcut-verb-queue-navigate"),
    ).toBeVisible();
    await expect(page.getByTestId("shortcut-queue-move-arrows")).toBeVisible();
    // Keys xyflow implements, documented honestly rather than claimed — the
    // space bar included, which is live on a focused node whether or not this
    // codebase wanted it (`elementSelectionKeys`, plus `panActivationKeyCode`).
    await expect(
      page.getByTestId("shortcut-canvas-delete-selection"),
    ).toContainText("handled by xyflow");
    const spaceRow = page.getByTestId(
      "shortcut-canvas-toggle-focused-node-selection",
    );
    await expect(spaceRow).toContainText("Space");
    await expect(spaceRow).toContainText("handled by xyflow");
    // And documented as xyflow actually behaves: unselecting the focused node
    // needs the multi-selection key held, so the row says so rather than
    // promising a bare toggle it does not perform.
    await expect(spaceRow).toContainText("Shift");

    // Every chord that fires a binding is shown, not just the first: a hidden
    // second key is the same failure as an unlisted binding (§11).
    await expect(
      page.getByTestId("shortcut-command-palette-close"),
    ).toContainText("Escape / Ctrl+K");
    await expect(
      page.getByTestId("shortcut-shortcuts-overlay-close"),
    ).toContainText("Escape / ?");
    await expect(page.getByTestId("shortcut-palette-rail-place")).toContainText(
      "Enter / Space",
    );

    // Trapped: focus is inside the dialog, and stays there however many Tabs.
    const focusedInsideOverlay = () =>
      page.evaluate(
        () =>
          document
            .querySelector('[data-testid="shortcuts-overlay"]')
            ?.contains(document.activeElement) ?? false,
      );
    expect(await focusedInsideOverlay()).toBe(true);
    for (let press = 0; press < 6; press++) {
      await page.keyboard.press("Tab");
      expect(await focusedInsideOverlay()).toBe(true);
    }

    // Restored: Escape closes it and focus returns where the gesture started.
    await page.keyboard.press("Escape");
    await expect(overlay).toHaveCount(0);
    await expect(queuePanelButton).toBeFocused();
  });

  test("the documented delete keys really delete, and one gesture is one undo", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const base = requireServer().baseUrl;
    const { nodeId } = await createCommandNode(base, "keyboard delete");

    await page.goto(`${base}/`);
    await expect(page.getByTestId("attention-header-count")).toBeVisible();
    await ensureNotCollapsed(page);

    const node = page.locator(`.react-flow__node[data-id="${nodeId}"]`);
    await expect(node).toHaveCount(1);

    // `Delete` is documented in the overlay beside `Backspace`, and xyflow's
    // own default is `Backspace` alone — so this is that row being true
    // rather than decorative (§11).
    await focusCanvasNode(page, nodeId);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Delete");
    await expect(node).toHaveCount(0);

    // One gesture, one undo op (principle 10): the same id comes back, which
    // is only possible because the delete lifted its own tombstone.
    await page.keyboard.press("Control+z");
    await expect(node).toHaveCount(1);

    // The other documented chord, on the same node.
    await focusCanvasNode(page, nodeId);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Backspace");
    await expect(node).toHaveCount(0);
  });

  test("run the selected node and stop the selected session, from the keyboard only", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const base = requireServer().baseUrl;
    const command = await createCommandNode(base, "keyboard run and stop");

    await page.goto(`${base}/`);
    await ensureNotCollapsed(page);
    await expect(
      page.getByTestId(`canvas-node-${command.nodeId}`),
    ).toBeVisible();

    // Reach the node by focus and select it with Enter — selection is the
    // route (§5), so the address itself now names this node.
    await focusCanvasNode(page, command.nodeId);
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate(() => window.location.search))
      .toContain(command.nodeId);

    // `R`: the same run gesture the node's own button calls (§4.1).
    await page.keyboard.press("r");

    const sessionNode = page
      .locator('[data-testid^="canvas-node-"]', {
        hasText: /^session sess_/,
      })
      .last();
    await expect(sessionNode).toBeVisible({ timeout: 20_000 });
    const sessionNodeId = await sessionNode.evaluate((element) =>
      (element.getAttribute("data-testid") ?? "").replace("canvas-node-", ""),
    );
    // The node's own label carries the session id it stands for, so the id
    // comes from what the keyboard gesture actually produced rather than from
    // guessing at the newest row of an unrelated list.
    const sessionLabel = (await sessionNode.textContent()) ?? "";
    const sessionId = /sess_[A-Za-z0-9_-]+/.exec(sessionLabel)?.[0];
    expect(sessionId).toBeTruthy();

    // Select the session node the same keyboard way, then `S` to stop it —
    // §6.7's narrowest scope, through the same `stopScope` action the Stop
    // panel's buttons use.
    await ensureNotCollapsed(page);
    await focusCanvasNode(page, sessionNodeId);
    await page.keyboard.press("Enter");
    await page.keyboard.press("s");

    await expect
      .poll(
        async () => {
          const read = await apiGet<{
            session: { end: { kind: string } | null };
          }>(base, `/api/sessions/${sessionId}`);
          return read.session.end?.kind ?? null;
        },
        { timeout: 20_000 },
      )
      .not.toBeNull();
  });

  test("the queue answers from the keyboard with nothing open", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const base = requireServer().baseUrl;
    const command = await createCommandNode(base, "keyboard queue answer");

    const run = await apiPost<{ session: { id: string } | null }>(
      base,
      "/api/runs",
      {
        commandId: command.commandId,
        initiationKey: `a11y-question-${crypto.randomUUID()}`,
        runtime: {
          script: {
            acts: [
              {
                on: "start",
                steps: [
                  { observation: { kind: "turn-started", turn: 1 } },
                  {
                    ask: {
                      text: "should this ship today?",
                      options: ["yes", "no"],
                    },
                  },
                  {
                    observation: {
                      kind: "output-delta",
                      text: "thanks, shipping",
                    },
                  },
                  {
                    observation: {
                      kind: "turn-ended",
                      turn: 1,
                      usage: { inputTokens: 5, outputTokens: 5 },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    );
    if (run.session === null) {
      throw new Error("the question session was queued, not started");
    }
    const sessionId = run.session.id;

    await page.goto(`${base}/`);
    // The header count is the queue's own derivation (§7), so waiting on it
    // proves the question has reached the attention feed the cursor reads —
    // without opening the Queue panel, which is the point.
    await expect
      .poll(
        async () =>
          (await page.getByTestId("attention-header-count").textContent()) ??
          "",
        { timeout: 20_000 },
      )
      .not.toContain("attention: 0");

    // Nothing is open: no Queue panel, no dialog. `J` moves the host-held
    // cursor to the first row and `1` answers with its first option.
    await expect(page.getByTestId("attention-queue")).toHaveCount(0);
    await page.keyboard.press("j");
    await page.keyboard.press("1");

    await expect
      .poll(
        async () => {
          const read = await apiGet<{
            questions: readonly { answer: unknown }[];
          }>(base, `/api/sessions/${sessionId}/questions`);
          return read.questions.some((question) => question.answer !== null);
        },
        { timeout: 20_000 },
      )
      .toBe(true);
  });

  test("streaming announces on start and completion, never per token", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const base = requireServer().baseUrl;
    const command = await createCommandNode(base, "keyboard streaming");

    // The default scripted run (`MILESTONE_SCRIPT`) paces turn 1 with real
    // delays, so the panel opens while the session is still streaming — which
    // is what makes "announced on start" observable rather than inferred.
    const run = await apiPost<{ session: { id: string } | null }>(
      base,
      "/api/runs",
      {
        commandId: command.commandId,
        initiationKey: `a11y-stream-${crypto.randomUUID()}`,
      },
    );
    if (run.session === null) {
      throw new Error("the streaming session was queued, not started");
    }

    await page.goto(`${base}/`);
    await ensureNotCollapsed(page);
    const sessionNode = page
      .locator('[data-testid^="canvas-node-"]', {
        hasText: /^session sess_/,
      })
      .last();
    await expect(sessionNode).toBeVisible({ timeout: 20_000 });
    // Direct DOM clicks, not coordinate-based ones: an unstyled, undesigned
    // canvas (design gate, fleet rule 5) genuinely overlaps siblings and
    // bubbles from earlier sessions, and this must act on *these* elements.
    await sessionNode.evaluate((el) => (el as HTMLElement).click());
    await page
      .getByRole("button", { name: "Conversation", exact: true })
      .evaluate((el) => (el as HTMLElement).click());

    const announcement = page.getByTestId("stream-announcement");
    await expect(announcement).toHaveText("response started", {
      timeout: 20_000,
    });
    await expect(announcement).toHaveText("response complete", {
      timeout: 30_000,
    });
    // Never per token: the live region carries the two announcements and no
    // transcript content at any point.
    await expect(announcement).not.toContainText("out.txt");
  });
});
