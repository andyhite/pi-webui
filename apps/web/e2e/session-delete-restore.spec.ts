/**
 * THE SESSION DELETE/RESTORE GATE (issue #65).
 *
 * Proves, end to end, against a real spawned server (`PLOTROOM_RUNTIME=
 * scripted`) and a real local git repository, loaded as the server's own
 * served page (single origin, spec §12) in a real Chromium tab:
 *
 *   - The session card's delete button destroys the session record over
 *     `DELETE /api/sessions/:id` (§3.6) — the node disappears from the
 *     canvas, not merely the local, server-oblivious removal the bare
 *     canvas delete key performs for every other node role.
 *   - The restorable panel — which had no reader over `GET /api/restorable`
 *     at all before this — lists the deleted session, and its own "restore"
 *     button brings the record (and its node) back over the session's own
 *     `POST /api/sessions/:id/restore`, live, with no reload (principle 10).
 *
 * Run locally: `bun run build && bun run --filter=@plotroom/web e2e` (root
 * `bun run build` — or at least `@plotroom/core`, `@plotroom/ui`,
 * `@plotroom/server`, and `@plotroom/web` — must have already produced
 * `apps/server/dist` and `apps/web/dist`; this suite spawns the former and
 * serves the latter, neither of which exists until built).
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
      "the session delete/restore gate's server never started (beforeAll failed)",
    );
  }
  return server;
}

/**
 * The workstream zoom level force-collapses containers (hiding the session
 * node this test needs to click), so this zooms in with the canvas's own
 * wheel-zoom interaction until the (test-only) zoom-level hook reports
 * anything other than "workstream", with proper waits, no sleeps — the same
 * helper every other canvas gate in this suite carries its own copy of.
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

async function createOpenDefinition(
  base: string,
  name: string,
): Promise<string> {
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

test("the session card's delete button destroys the record; the restorable panel brings it back", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const base = requireServer().baseUrl;
  const marker = crypto.randomUUID().slice(0, 8);

  const definitionId = await createOpenDefinition(
    base,
    `delete-restore-e2e-${marker}`,
  );
  const workstream = await apiPost<{ workstream: { id: string } }>(
    base,
    "/api/workstreams",
    {},
  );
  const command = await apiPost<{ command: { id: string } }>(
    base,
    "/api/commands",
    { definitionId, workstreamId: workstream.workstream.id },
  );
  const run = await apiPost<{ session: { id: string } | null }>(
    base,
    "/api/runs",
    { commandId: command.command.id, initiationKey: `delete-e2e-${marker}` },
  );
  if (run.session === null) {
    throw new Error(
      "the delete/restore fixture session was queued, not started",
    );
  }
  const sessionId = run.session.id;

  await page.goto(`${base}/`);
  await ensureNotCollapsed(page);

  const sessionNode = page.locator('[data-testid^="canvas-node-"]', {
    hasText: new RegExp(`session ${sessionId}`),
  });
  await expect(sessionNode).toBeVisible();

  // A direct DOM click, not Playwright's coordinate-based one — this
  // suite's other gates use the same for a sibling node's card button on an
  // unstyled, undesigned canvas that can genuinely overlap nodes (design
  // gate, fleet rule 5).
  await sessionNode
    .getByRole("button", { name: "delete" })
    .evaluate((el) => (el as HTMLElement).click());

  // The node is gone from the canvas — not merely unplaced locally (the bare
  // delete key's mechanic): the record itself was destroyed server-side.
  await expect(sessionNode).toHaveCount(0);

  await page.getByRole("button", { name: "Restorable", exact: true }).click();
  const row = page.getByTestId(`restorable-row-${sessionId}`);
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "restore" }).click();

  // Restored live, with no reload: the row leaves the restorable list...
  await expect(row).toHaveCount(0);
  // ...and the session's node is back on the canvas.
  await expect(sessionNode).toBeVisible({ timeout: 15_000 });
});
