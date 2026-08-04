/**
 * ARRANGEMENT DURABILITY AND RESET (Epic 8.5, Epic 3.1, spec §5, §12).
 *
 * "Placement is durable, including across restarts... An initial
 * arrangement is derived from the graph's structure so a new node appears
 * somewhere sensible; reset arrangement is the only automatic-layout verb,
 * and it re-derives from structure." (§5)
 *
 * KNOWN GAP, STATED HONESTLY (see the second test's own doc comment, and
 * report this prominently rather than gloss over it): the renderer
 * (`apps/web/src/App.tsx`) persists node positions *only* to the browser's
 * own `localStorage` (`createWebStoragePlacementStore`) — dragging a node
 * and "reset arrangement" both write there and nowhere else. It never reads
 * `PlacedNode.position` off `/api/snapshot`, and never calls the server's
 * own `PATCH /api/nodes/:id/position` / `PATCH /api/arrangement`. This is
 * Epic 3.1's own recorded deferral ("the renderer still writes to
 * localStorage until it adopts those endpoints" — see issue #13 (Canvas
 * foundation), or docs/development-plan.md in git history), not a new
 * finding — but it does mean this file
 * deliberately does **not** contain a "drag a node in the browser, restart
 * the *server*, reload, assert the position survived" test: as things
 * stand today that would either (a) pass for the wrong reason purely off
 * browser `localStorage`, proving nothing about the server, or (b) fail if
 * run in a fresh browser context with cleared storage — a true finding, but
 * one this batch cannot fix without editing `apps/web/src/App.tsx`
 * (production code, outside this batch's file ownership). The first test
 * below proves the real, already-landed guarantee directly instead — the
 * server's own durability of an authored position across a process
 * restart, at the layer that actually implements it — structured so a
 * follow-up wiring the renderer to these same endpoints (in progress on
 * another branch, per the batch's own coordination) can add a browser-level
 * leg on top without this test needing to change. The second test proves
 * "reset arrangement" through the real UI, which needs no server restart at
 * all since it re-derives from live graph structure on every invocation.
 */
import { expect, test, type Page } from "@playwright/test";

import {
  apiGet,
  apiPatch,
  apiPost,
  startMilestoneServer,
  type MilestoneServer,
} from "./server-harness.js";
import {
  startRestartableServer,
  type RestartableServer,
} from "./canvas-restart-harness.js";
import { dragNodeBy, flowPosition } from "./canvas-drag-helpers.js";

interface SnapshotNodesRead {
  readonly nodes: readonly {
    readonly id: string;
    readonly position: { readonly x: number; readonly y: number } | null;
  }[];
}

async function createContentNode(base: string, title: string): Promise<string> {
  const object = await apiPost<{ object: { id: string } }>(
    base,
    "/api/objects",
    {
      kind: "ticket",
      title,
      renderings: { card: {}, summary: title, agentContent: title },
    },
  );
  const node = await apiPost<{ node: { id: string } }>(base, "/api/nodes", {
    role: "content",
    refId: object.object.id,
  });
  return node.node.id;
}

test.describe("(a) server-side arrangement durability across a process restart", () => {
  let restartable: RestartableServer | undefined;

  test.afterEach(async () => {
    if (restartable) {
      await restartable.stop();
      restartable = undefined;
    }
  });

  test("an authored position, and an explicitly-unset one, both survive killing and respawning the server on the same state dir", async () => {
    test.setTimeout(60_000);
    restartable = await startRestartableServer();
    const baseBefore = restartable.baseUrl;

    const placedId = await createContentNode(baseBefore, "Durability placed");
    const untouchedId = await createContentNode(
      baseBefore,
      "Durability untouched",
    );

    // Authored via the real gesture the canvas's own drag-end handler is
    // meant to call (§5's durable-placement endpoint, Epic 2.3):
    const authoredPosition = { x: 4321, y: -987 };
    await apiPatch(baseBefore, "/api/arrangement", {
      positions: [{ nodeId: placedId, position: authoredPosition }],
    });

    // Sanity before the restart: both rows already read back correctly.
    const beforeRestart = await apiGet<SnapshotNodesRead>(
      baseBefore,
      "/api/snapshot",
    );
    const placedBefore = beforeRestart.nodes.find(
      (node) => node.id === placedId,
    );
    const untouchedBefore = beforeRestart.nodes.find(
      (node) => node.id === untouchedId,
    );
    expect(placedBefore?.position).toEqual(authoredPosition);
    expect(untouchedBefore?.position ?? null).toBeNull();

    await restartable.restart();
    const baseAfter = restartable.baseUrl;

    const afterRestart = await apiGet<SnapshotNodesRead>(
      baseAfter,
      "/api/snapshot",
    );
    const placedAfter = afterRestart.nodes.find((node) => node.id === placedId);
    const untouchedAfter = afterRestart.nodes.find(
      (node) => node.id === untouchedId,
    );

    // The authored position survived the process boundary, bit-for-bit —
    // never silently re-derived, never dropped.
    expect(placedAfter?.position).toEqual(authoredPosition);
    // A node nobody ever positioned must not acquire one just because the
    // process restarted — no phantom placement invented on the way back up.
    expect(untouchedAfter?.position ?? null).toBeNull();

    // Clearing an authored position (null, §5: "there is no sentinel like
    // 0,0 to misread as unset") is itself durable, not merely the presence
    // of one — the same restart proves both directions of the claim.
    await apiPatch(baseAfter, "/api/arrangement", {
      positions: [{ nodeId: placedId, position: null }],
    });
    await restartable.restart();
    const baseFinal = restartable.baseUrl;
    const finalRead = await apiGet<SnapshotNodesRead>(
      baseFinal,
      "/api/snapshot",
    );
    expect(
      finalRead.nodes.find((node) => node.id === placedId)?.position ?? null,
    ).toBeNull();
  });
});

test.describe("(b) reset arrangement, through the real UI", () => {
  let server: MilestoneServer | undefined;

  test.beforeAll(async () => {
    server = await startMilestoneServer();
  });

  test.afterAll(async () => {
    if (server) await server.stop();
  });

  function requireServer(): MilestoneServer {
    if (!server) {
      throw new Error(
        "the reset-arrangement server never started (beforeAll failed)",
      );
    }
    return server;
  }

  /**
   * Opens the command palette and runs the verb whose row label is
   * *exactly* `label` — never a substring match against whatever else is on
   * the graph. The palette's own filter is intentionally substring/
   * case-insensitive (`filterCommandPaletteItems`), which is right for a
   * human typing a partial query, but a query string that also happens to
   * be a *substring of an unrelated node's title* (a ticket or command
   * named containing the same words) matches that row's own "navigate"
   * item too — and by DOM order, ahead of the verb. Matching the row by its
   * exact rendered text is what makes this robust regardless of what else
   * exists on the graph.
   */
  async function openCommandPaletteAndRunVerb(
    page: Page,
    label: string,
  ): Promise<void> {
    await page.keyboard.press("Control+k");
    const palette = page.getByTestId("command-palette");
    await expect(palette).toBeVisible();
    await page
      .getByRole("combobox", { name: "command palette query" })
      .fill(label);
    const option = page.getByRole("option").filter({
      has: page.getByRole("button", { name: label, exact: true }),
    });
    await expect(option).toHaveCount(1);
    await option.getByRole("button", { name: label, exact: true }).click();
    await expect(palette).toHaveCount(0);
  }

  test("dragging a node persists across a reload, and 'reset arrangement' snaps it back to the derived layout", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const base = requireServer().baseUrl;

    // Deliberately named to share *no* words with the "reset arrangement"
    // verb itself — see `openCommandPaletteAndRunVerb`'s own doc comment for
    // why that matters here specifically.
    const ticketObject = await apiPost<{ object: { id: string } }>(
      base,
      "/api/objects",
      {
        kind: "ticket",
        title: "Arrangement gate fixture ticket",
        renderings: {
          card: {},
          summary: "Arrangement gate fixture ticket",
          agentContent: "context for the arrangement-durability gate",
        },
      },
    );
    const ticketNode = await apiPost<{ node: { id: string } }>(
      base,
      "/api/nodes",
      { role: "content", refId: ticketObject.object.id },
    );
    const ticketNodeId = ticketNode.node.id;

    const definition = await apiPost<{ definition: { id: string } }>(
      base,
      "/api/command-definitions",
      {
        name: "arrangement gate fixture command",
        instruction: "stand in for whatever this test's script does",
        model: "e2e-fixture-model",
        effort: "low",
        lifecycle: "open",
      },
    );
    const workstream = await apiPost<{ workstream: { id: string } }>(
      base,
      "/api/workstreams",
      {},
    );
    const command = await apiPost<{ node: { id: string } }>(
      base,
      "/api/commands",
      {
        definitionId: definition.definition.id,
        workstreamId: workstream.workstream.id,
      },
    );
    const commandNodeId = command.node.id;
    await apiPost(base, "/api/edges", {
      from: ticketNodeId,
      to: commandNodeId,
    });

    // A fresh, storage-free context every time this suite runs (Playwright's
    // default `page` fixture — no prior localStorage from another test),
    // so the very first render is `deriveInitialArrangement`'s own output.
    // The wired command node exists so the derived layout is non-trivial
    // (two layers, not one node sitting at the origin) — the drag/reset
    // assertions below act on the *ticket*, deliberately: it is a bare,
    // top-level node with an absolute flow position, never a contained
    // node's parent-relative offset (which the command node's own position
    // is, since it is placed inside the workstream container — dragging and
    // resetting a contained node would also be entangled with the
    // container's *own* position, a second moving part this test has no
    // need to take on).
    void commandNodeId;
    await page.goto(`${base}/`);
    const ticketLocator = page.getByTestId(`canvas-node-${ticketNodeId}`);
    await expect(ticketLocator).toBeVisible();
    // Flow-space position, read off xyflow's own node wrapper
    // (`rf__node-<id>`, distinct from this canvas's own `canvas-node-<id>`
    // testid on the inner card) — deliberately *not* a screen bounding box:
    // `page.reload()` below re-runs `fitView`, which computes a fresh
    // pan/zoom over whatever the arrangement's bounding box is *at that
    // moment*, so the same flow position renders at different screen
    // pixels before and after — comparing screen boxes across a reload
    // compares two different viewport transforms, not the position itself.
    const ticketWrapper = page.locator(
      `[data-testid="rf__node-${ticketNodeId}"]`,
    );
    const derivedPosition = await flowPosition(ticketWrapper);

    await dragNodeBy(page, ticketLocator, { x: 260, y: 220 });
    const draggedPosition = await flowPosition(ticketWrapper);
    expect(draggedPosition).not.toEqual(derivedPosition);

    // Persists across a reload of the same page — the browser-level half of
    // "arranging by hand never costs an earlier placement" (§5), true today
    // regardless of the server-side gap this file's doc comment names.
    await page.reload();
    await expect(ticketLocator).toBeVisible();
    const reloadedPosition = await flowPosition(ticketWrapper);
    expect(reloadedPosition.x).toBeCloseTo(draggedPosition.x, 0);
    expect(reloadedPosition.y).toBeCloseTo(draggedPosition.y, 0);

    // §5's only automatic-layout verb: re-derives from structure, snapping
    // the manually-moved node back to exactly where it started.
    await openCommandPaletteAndRunVerb(page, "reset arrangement");
    await expect
      .poll(async () => {
        const position = await flowPosition(ticketWrapper);
        return { x: Math.round(position.x), y: Math.round(position.y) };
      })
      .toEqual({
        x: Math.round(derivedPosition.x),
        y: Math.round(derivedPosition.y),
      });
  });
});
