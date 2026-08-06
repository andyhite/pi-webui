/**
 * THE RUN-GUARD RACE GATE (issue #226).
 *
 * Proves, end to end, against a real spawned server (`PLOTROOM_RUNTIME=
 * scripted`) and a real local git repository, loaded as the server's own
 * served page (single origin, spec §12) in a real Chromium tab:
 *
 * A run gesture is never silently dropped. `App.tsx`'s `runCommandNode` used
 * to decide "already in flight?" by reading a variable a `setRunsInFlight`
 * updater assigned — a decision React does not promise runs during the
 * `setState` call itself (the eager-state optimization only applies while
 * that hook's update queue is empty). Firing several run gestures back to
 * back, with no settle time between any two of them, used to reproduce the
 * race close to 100% of the time against this file's own recipe (before the
 * fix): a later gesture's decision was read stale, the node was marked in
 * flight and stuck there, and no `POST /api/runs` was ever sent for it — a
 * silent, permanent drop, `apps/web/src/App.tsx`'s own §11 "no silent
 * refusal" rule broken by the runtime rather than by an authored refusal.
 *
 * A dedicated file with its own server (rather than appended to `a11y.
 * spec.ts`, where it started): the race is stressed by firing the gesture
 * back to back across several nodes, and a shared server accumulating every
 * other test's own workstreams first made the canvas crowded enough to make
 * *this* test's own node-visibility waits the flaky part, obscuring the
 * actual assertion.
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
    throw new Error(
      "the run-guard race gate's server never started (beforeAll failed)",
    );
  }
  return server;
}

/** Same zoom-in-until-not-collapsed helper every canvas gate in this suite carries its own copy of. */
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

/** The id of whatever xyflow node currently has focus, or null. */
async function focusedNodeId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const active = document.activeElement;
    const wrapper = active?.closest(".react-flow__node") ?? null;
    return wrapper?.getAttribute("data-id") ?? null;
  });
}

/** Focuses a canvas node the way a keyboard reaches it — never a click. */
async function focusCanvasNode(page: Page, nodeId: string): Promise<void> {
  await page
    .locator(`.react-flow__node[data-id="${nodeId}"]`)
    .evaluate((element) => (element as HTMLElement).focus());
  await expect.poll(() => focusedNodeId(page)).toBe(nodeId);
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

test("a run gesture is never silently dropped, even fired back to back with no settle time between", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const base = requireServer().baseUrl;
  const marker = crypto.randomUUID().slice(0, 8);

  const commands = await Promise.all(
    Array.from({ length: 6 }, async (_, i) => {
      const definitionId = await createDefinition(
        base,
        `run-guard-race-${marker}-${i}`,
      );
      const workstream = await apiPost<{ workstream: { id: string } }>(
        base,
        "/api/workstreams",
        {},
      );
      const command = await apiPost<{ node: { id: string } }>(
        base,
        "/api/commands",
        { definitionId, workstreamId: workstream.workstream.id },
      );
      return {
        nodeId: command.node.id,
        workstreamId: workstream.workstream.id,
      };
    }),
  );

  await page.goto(`${base}/`);
  await ensureNotCollapsed(page);

  // Fire every gesture back to back, with no wait for a session to appear
  // between any two of them — the exact shape that raced a stale read out
  // of a `setState` updater against the next gesture's own state update
  // (#226): the guard now decides synchronously off a ref, so nothing here
  // should ever hit "already in flight" for a *different* node, and no
  // gesture should be dropped without ever sending its request.
  for (const command of commands) {
    await expect(page.getByTestId(`canvas-node-${command.nodeId}`)).toBeVisible(
      { timeout: 20_000 },
    );
    await focusCanvasNode(page, command.nodeId);
    await page.keyboard.press("Enter");
    await page.keyboard.press("r");
  }

  // One session per command, never fewer — a dropped gesture leaves its node
  // stuck on "running…" forever and starts no session at all, which is the
  // failure this asserts against directly rather than inferring it from a UI
  // timeout.
  await expect
    .poll(
      async () => {
        const counts = await Promise.all(
          commands.map((command) =>
            apiGet<{ sessions: readonly unknown[] }>(
              base,
              `/api/sessions?workstreamId=${command.workstreamId}`,
            ),
          ),
        );
        return counts.filter((c) => c.sessions.length > 0).length;
      },
      { timeout: 20_000 },
    )
    .toBe(commands.length);
});
