/**
 * ARRANGEMENT DURABILITY AND RESET (Epic 8.5, Epic 3.1, spec §5, §12).
 *
 * "Placement is durable, including across restarts... An initial
 * arrangement is derived from the graph's structure so a new node appears
 * somewhere sensible; reset arrangement is the only automatic-layout verb,
 * and it re-derives from structure." (§5)
 *
 * Three legs, and the middle one is no longer a gap. When this file was
 * written the renderer persisted positions only to the browser's own
 * `localStorage`, so a "drag it, reload, assert it survived" test could only
 * pass off browser storage and prove nothing about the server. That deferral
 * is closed: `apps/web/src/App.tsx` enqueues every settled gesture to
 * `PATCH /api/arrangement` in `LIVE` mode (`placement/write-queue.ts`). The
 * local store is the offline/fixture path now, plus one LIVE-mode read at boot
 * that migrates whatever an older build left behind.
 *
 *   (a) The server's own durability of an authored position across a process
 *       restart, at the layer that implements it.
 *   (b) "Reset arrangement" through the real UI — §5's only automatic-layout
 *       verb, which needs no restart since it re-derives from live structure.
 *   (c) A **contained** node's drag: persisted parent-relative, read back off
 *       the server rather than off browser storage, and pushing the sibling it
 *       lands on without letting it leave its container's frame.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  apiGet,
  apiPatch,
  apiPost,
  startMilestoneServer,
  stopOnTeardown,
  type MilestoneServer,
} from "./server-harness.js";
import {
  startRestartableServer,
  type RestartableServer,
} from "./canvas-restart-harness.js";
import {
  dragNodeBy,
  flowPosition,
  waitForSettled,
  zoomPastWorkstreamLevel,
} from "./canvas-drag-helpers.js";

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

  stopOnTeardown(() => server);

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

test.describe("(c) a contained node's own arrangement", () => {
  let server: MilestoneServer | undefined;

  test.beforeAll(async () => {
    server = await startMilestoneServer();
  });

  stopOnTeardown(() => server);

  function requireContainedServer(): MilestoneServer {
    if (!server) {
      throw new Error(
        "the contained-arrangement server never started (beforeAll failed)",
      );
    }
    return server;
  }

  /** Flow-space size of a node, unscaled by the viewport's own transform. */
  async function flowSize(
    wrapper: Locator,
  ): Promise<{ readonly width: number; readonly height: number }> {
    return wrapper.evaluate((element) => ({
      width: (element as HTMLElement).offsetWidth,
      height: (element as HTMLElement).offsetHeight,
    }));
  }

  async function createCommandInWorkstream(
    base: string,
    workstreamId: string,
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
    const command = await apiPost<{ node: { id: string } }>(
      base,
      "/api/commands",
      { definitionId: definition.definition.id, workstreamId },
    );
    return command.node.id;
  }

  test("a contained node's drag is persisted as an offset inside its container, and pushes the sibling it lands on", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const base = requireContainedServer().baseUrl;

    // Two workstreams, each with two children. The derived top-level layout
    // puts unwired nodes in their own rows, so exactly one of the two
    // containers can be at the origin — and the test runs against the other.
    // That matters for the assertion this test exists to make: for a container
    // at (0,0) a parent-relative offset and an absolute position are the same
    // numbers, so storing absolutes would pass unnoticed.
    const workstreams: { readonly id: string; readonly children: string[] }[] =
      [];
    for (const label of ["first", "second"]) {
      const workstream = await apiPost<{ workstream: { id: string } }>(
        base,
        "/api/workstreams",
        {},
      );
      const id = workstream.workstream.id;
      const children = [
        await createCommandInWorkstream(base, id, `${label} contained child a`),
        await createCommandInWorkstream(base, id, `${label} contained child b`),
      ];
      workstreams.push({ id, children });
    }

    await page.goto(`${base}/`);
    await expect(page.getByTestId("attention-header-count")).toBeVisible();
    await zoomPastWorkstreamLevel(page);

    const offOrigin: { id: string; children: string[] }[] = [];
    for (const candidate of workstreams) {
      const position = await flowPosition(
        page.locator(`[data-testid="rf__node-${candidate.id}"]`),
      );
      if (position.x !== 0 || position.y !== 0) offOrigin.push(candidate);
    }
    const subject = offOrigin[0];
    if (!subject) {
      throw new Error(
        "both containers derived to the origin, so a parent-relative offset would be indistinguishable from an absolute position",
      );
    }
    const workstreamId = subject.id;

    const containerWrapper = page.locator(
      `[data-testid="rf__node-${workstreamId}"]`,
    );

    // **Which child is dragged is decided by where the layout actually put
    // them, never by the order they were created in.** A container's children
    // go through `gridPositions` with no `rowPriority`, so every child scores 0
    // and the comparator falls through to `a.localeCompare(b)` on the node ids
    // (`placement/derive.ts`) — random uuids, so creation order decided nothing
    // and the old assignment was a coin flip that landed wrong here.
    //
    // It is a fatal coin flip, because the direction of the push is what this
    // test asserts. The lower child is flush against the frame's bottom edge
    // (the second derived row overflows the frame, #206), and a downward push
    // correctly has nowhere to go: `contained-push.ts` leaves the overlap
    // rather than shoving a child through its own workstream's wall. Dragging
    // the lower child *upward* pushes the upper one into room that exists.
    const relativeY = async (id: string): Promise<number> => {
      const child = await flowPosition(
        page.locator(`[data-testid="rf__node-${id}"]`),
      );
      const frame = await flowPosition(containerWrapper);
      return child.y - frame.y;
    };
    const [first, second] = subject.children as [string, string];
    const byRow =
      (await relativeY(first)) < (await relativeY(second))
        ? { upper: first, lower: second }
        : { upper: second, lower: first };
    const pushedId = byRow.upper;
    const draggedId = byRow.lower;

    const draggedWrapper = page.locator(
      `[data-testid="rf__node-${draggedId}"]`,
    );
    const pushedWrapper = page.locator(`[data-testid="rf__node-${pushedId}"]`);
    const draggedCard = page.getByTestId(`canvas-node-${draggedId}`);
    const pushedCard = page.getByTestId(`canvas-node-${pushedId}`);
    await expect(draggedCard).toBeVisible();
    await expect(pushedCard).toBeVisible();

    const relativeOf = async (
      wrapper: Locator,
    ): Promise<{ readonly x: number; readonly y: number }> => {
      const absolute = await flowPosition(wrapper);
      const frame = await flowPosition(containerWrapper);
      return { x: absolute.x - frame.x, y: absolute.y - frame.y };
    };

    const pushedBefore = await relativeOf(pushedWrapper);

    // Land the dragged child **overlapping** its sibling, still below it:
    // inside a container the push is the same rigid-body rule as the top level
    // (§5), and this is the half of it that used to stop at the container's
    // edge.
    //
    // The gap is what makes the outcome one thing rather than two. `separate`
    // pushes along the axis of least penetration and away from the *mover's*
    // centre (`solver/push.ts`), so a card landed exactly on its sibling has
    // equal centres and the `>=` tie-break sends the sibling **down**, while a
    // drag that arrives a pixel short sends it **up**. Dropping precisely on
    // top therefore makes the direction a function of sub-pixel drag arrival —
    // it passed locally and pushed the other way in CI. Stopping deliberately
    // short leaves 68px of overlap with the centres a clear 40px apart, so the
    // sibling is pushed up, and up is where the room is.
    const OVERLAP_GAP = 40;
    const from = await draggedCard.boundingBox();
    const onto = await pushedCard.boundingBox();
    if (!from || !onto) throw new Error("a contained card had no bounding box");
    expect(OVERLAP_GAP).toBeLessThan(onto.height);
    // #347: `alsoSettle` waits for the pushed sibling too — settling only
    // the dragged card let a caller read the sibling's still-committing
    // frame on WebKit.
    await dragNodeBy(
      page,
      draggedCard,
      { x: onto.x - from.x, y: onto.y - from.y + OVERLAP_GAP },
      { alsoSettle: [pushedCard] },
    );

    const pushedAfter = await relativeOf(pushedWrapper);
    // Not merely "it moved": the direction is the thing this test exists to
    // get right, and an inverted rule would move the sibling the same distance
    // the other way and satisfy a bare inequality.
    expect(pushedAfter).not.toEqual(pushedBefore);
    expect(pushedAfter.y).toBeLessThan(pushedBefore.y);

    // Persisted on the **server**, and as an offset inside the container
    // rather than an absolute position — which is exactly what the canvas
    // hands a node with `extent: "parent"`. Storing absolutes would displace
    // every child by its container's own position on the next reload.
    const draggedRelative = await relativeOf(draggedWrapper);
    const storedPositions = async (): Promise<
      ReadonlyMap<string, { readonly x: number; readonly y: number }>
    > => {
      const read = await apiGet<SnapshotNodesRead>(base, "/api/snapshot");
      const stored = new Map<string, { x: number; y: number }>();
      for (const node of read.nodes) {
        if (node.position) stored.set(node.id, node.position);
      }
      return stored;
    };
    await expect
      .poll(
        async () => {
          const stored = (await storedPositions()).get(draggedId);
          return stored
            ? { x: Math.round(stored.x), y: Math.round(stored.y) }
            : null;
        },
        { timeout: 15_000 },
      )
      .toEqual({
        x: Math.round(draggedRelative.x),
        y: Math.round(draggedRelative.y),
      });

    // The pushed sibling's *stored* offset is inside the frame, which is what
    // the clamp is actually about: xyflow re-clamps what it draws on every
    // store update, so a screen box sits inside the frame with or without
    // `clampInsideParent`. It is the persisted value — and the value the next
    // drag frame solves against — that the clamp changes.
    const frameSize = await flowSize(containerWrapper);
    const pushedSize = await flowSize(pushedWrapper);
    const storedPushed = (await storedPositions()).get(pushedId);
    if (!storedPushed) {
      throw new Error("the pushed sibling's position was never persisted");
    }
    expect(storedPushed.x).toBeGreaterThanOrEqual(0);
    expect(storedPushed.y).toBeGreaterThanOrEqual(0);
    expect(storedPushed.x).toBeLessThanOrEqual(
      frameSize.width - pushedSize.width,
    );
    expect(storedPushed.y).toBeLessThanOrEqual(
      frameSize.height - pushedSize.height,
    );

    // And both survive a reload with no browser storage in play: the offsets
    // come back off the snapshot the server just answered with. Compared as
    // offsets, because the container's own position is derived rather than
    // authored — it returns to where structure puts it, and the children go
    // with it.
    await page.reload();
    await expect(page.getByTestId("attention-header-count")).toBeVisible();
    await zoomPastWorkstreamLevel(page);
    await expect(draggedCard).toBeVisible();
    // #347: a reload re-derives the container's layout from scratch, which
    // can still be mid-commit the instant `draggedCard` first becomes
    // visible — settle both cards before trusting their positions.
    await waitForSettled([draggedCard, pushedCard]);
    const reloadedDragged = await relativeOf(draggedWrapper);
    const reloadedPushed = await relativeOf(pushedWrapper);
    expect(reloadedDragged.x).toBeCloseTo(draggedRelative.x, 0);
    expect(reloadedDragged.y).toBeCloseTo(draggedRelative.y, 0);
    expect(reloadedPushed.x).toBeCloseTo(pushedAfter.x, 0);
    expect(reloadedPushed.y).toBeCloseTo(pushedAfter.y, 0);
  });
});
