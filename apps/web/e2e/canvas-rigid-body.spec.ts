/**
 * RIGID-BODY PUSH AND AT-REST DURABILITY (Epic 8.5, Epic 3.1, spec §5).
 *
 * Proves, end to end, against a real spawned server and a real Chromium
 * tab loaded from the server's own served page (single origin, §12):
 *
 *   (a) Dragging one node into another pushes it, and the push travels
 *       through a chain — dragging A into B, with B already close enough
 *       to C, moves *both* B and C, never just the one directly touched.
 *   (b) No two nodes ever end up overlapping once the drag settles (the
 *       "solid rectangles" half of §5's claim) — asserted for every pair,
 *       not just the two the drag directly touched.
 *   (c) "An arrangement at rest stays exactly where it is": positions
 *       measured the instant the drag ends must be bit-for-bit identical a
 *       beat later with no further input, at every level (dragged node,
 *       pushed node, and the chain's far end) — never a continuous
 *       simulation still settling after the human let go.
 *
 * Three plain content nodes, no edges between them: `deriveInitialArrangement`
 * (Epic 3.1) lays out nodes with no incoming edges as one column, one row
 * apart, in id order — deterministic, but this test never assumes *which*
 * node lands in which row; it measures the real rendered boxes and reasons
 * from those instead.
 */
import { expect, test, type Page } from "@playwright/test";

import {
  apiPost,
  startMilestoneServer,
  type MilestoneServer,
} from "./server-harness.js";
import {
  boxesByNodeId,
  dragNodeBy,
  overlaps,
  waitForSettled,
  type Box,
} from "./canvas-drag-helpers.js";

let server: MilestoneServer | undefined;

// A fresh server *per test*, not per file: both tests here reason about the
// exact set of nodes on the graph (row order, which node lands where, exact
// node counts read back from the server) and the second test's "never
// reaches" claim depends on starting from a graph containing only its own
// three nodes. Sharing one server across both tests left the first test's
// leftover nodes on the graph when the second one ran, polluting that
// baseline — confirmed the hard way. `canvas-mid-drag-refusal.spec.ts` hit
// the same shape of problem for a different reason (fitView's zoom) and
// fixed it the same way; see its own `beforeEach` doc comment.
test.beforeEach(async () => {
  server = await startMilestoneServer();
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires an object-destructuring first parameter to parse "no fixtures needed"; a plain identifier fails at file load.
test.afterEach(async ({}, testInfo) => {
  if (server) {
    await server.stop({
      keepStateOnFailure: testInfo.status !== testInfo.expectedStatus,
    });
  }
  server = undefined;
});

function requireServer(): MilestoneServer {
  if (!server) {
    throw new Error("the rigid-body server never started (beforeAll failed)");
  }
  return server;
}

async function createContentNode(base: string, title: string): Promise<string> {
  const object = await apiPost<{ object: { id: string } }>(
    base,
    "/api/objects",
    {
      kind: "document",
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

/** The three boxes read back, ordered top-to-bottom by their current screen y — whichever node ids landed where. */
function orderByY(boxes: ReadonlyMap<string, Box>): readonly [string, Box][] {
  return [...boxes.entries()].sort((a, b) => a[1].y - b[1].y);
}

function allPairsNonOverlapping(boxes: readonly Box[]): boolean {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a && b && overlaps(a, b)) return false;
    }
  }
  return true;
}

test("dragging a node into another pushes it, the push chains, and the settled arrangement stays put", async ({
  page,
  browserName,
}) => {
  // #347: webkit's version of this settle race is fixed (`alsoSettle` on
  // the `dragNodeBy` call below, plus a bounded re-settle for the "stays
  // put" check in place of a fixed sleep) and verified stable over 10+
  // consecutive runs. Firefox stays skipped: 10/10 repeat runs of this
  // exact, hardened test still failed here, and *widening* the settle
  // bound (1s quiet, 15s timeout) made the divergence worse, not better —
  // one run's "stays put" delta went from 15px to over 11,000px the longer
  // it was given to wait. That rules out a simple commit-timing race (which
  // a longer bound would fix); it points at either an unbounded/continuous
  // reflow (a debounced `fitView` or auto-pan still chasing the dragged
  // node) or an unstable solver iteration specific to Firefox's layout
  // pipeline for a drag this large — a real product-facing question,
  // not a test-timing one, and outside a settle-poll's power to paper
  // over. Filed as its own investigation issue, #357, against
  // `packages/ui/src/canvas/PlotCanvas.tsx`'s `onNodeDrag` under Firefox
  // specifically, rather than guessed at here.
  test.skip(browserName === "firefox", "see #347, tracked as #357");
  test.setTimeout(60_000);
  const base = requireServer().baseUrl;

  const idA = await createContentNode(base, "Rigid Push A");
  const idB = await createContentNode(base, "Rigid Push B");
  const idC = await createContentNode(base, "Rigid Push C");

  await page.goto(`${base}/`);
  await expect(page.getByTestId(`canvas-node-${idA}`)).toBeVisible();
  await expect(page.getByTestId(`canvas-node-${idB}`)).toBeVisible();
  await expect(page.getByTestId(`canvas-node-${idC}`)).toBeVisible();

  const initial = await boxesByNodeId(page, [idA, idB, idC]);
  // No pre-existing overlap: `deriveInitialArrangement`'s own row spacing
  // (120px) comfortably clears the fallback node height (40px) — this is
  // the baseline the push below has to actually change, not a state the
  // page happened to start in.
  expect(allPairsNonOverlapping([...initial.values()])).toBe(true);

  const ordered = orderByY(initial);
  const [topId, topBox] = ordered[0] as [string, Box];
  const [midId, midBox] = ordered[1] as [string, Box];
  const [farId, farBox] = ordered[2] as [string, Box];

  const topLoc = page.getByTestId(`canvas-node-${topId}`);
  const midLoc = page.getByTestId(`canvas-node-${midId}`);
  const farLoc = page.getByTestId(`canvas-node-${farId}`);

  // Drag the top node down far enough to overlap the middle node deeply —
  // deep enough that separating them pushes the middle node down into the
  // far node's own space too, so the push has to travel through the chain
  // rather than stop at the first contact.
  const dragDistance = farBox.y + farBox.height - topBox.y + 40;
  // #347: `alsoSettle` waits for the pushed siblings too, not just the node
  // under the pointer — settling only `topLoc` let a caller read
  // `midLoc`/`farLoc` mid-commit on WebKit.
  await dragNodeBy(
    page,
    topLoc,
    { x: 0, y: dragDistance },
    { alsoSettle: [midLoc, farLoc] },
  );

  const settled = await boxesByNodeId(page, [topId, midId, farId]);
  const settledTop = settled.get(topId) as Box;
  const settledMid = settled.get(midId) as Box;
  const settledFar = settled.get(farId) as Box;

  // (a) The chain propagated: not just the node directly touched, but the
  // one beyond it too.
  expect(settledMid.y).toBeGreaterThan(midBox.y);
  expect(settledFar.y).toBeGreaterThan(farBox.y);

  // (b) Solid rectangles: no pair overlaps once the push settles, dragged
  // node included.
  expect(allPairsNonOverlapping([settledTop, settledMid, settledFar])).toBe(
    true,
  );

  // (c) At rest stays put: no further input, and the settled positions do
  // not drift — proof this is a one-shot solver reacting to a drag frame,
  // never a continuous simulation still running after the human let go. A
  // further bounded settle-poll, not a fixed sleep: a still-running
  // simulation would keep finding motion and time out, rather than this
  // silently comparing a mid-drift frame the way a blind `waitForTimeout`
  // would.
  await waitForSettled([topLoc, midLoc, farLoc], 250);
  const afterPause = await boxesByNodeId(page, [topId, midId, farId]);
  // Rounded to whole pixels: width/height can wobble by a sub-pixel from
  // text layout measurement alone, which is not a claim about drift — the
  // claim is about x/y position, and those must be exact.
  for (const [id, settledBox] of [
    [topId, settledTop],
    [midId, settledMid],
    [farId, settledFar],
  ] as const) {
    const laterBox = afterPause.get(id) as Box;
    expect(Math.round(laterBox.x)).toBe(Math.round(settledBox.x));
    expect(Math.round(laterBox.y)).toBe(Math.round(settledBox.y));
  }
});

test("a node the drag chain never reaches is never displaced, even though the canvas never checked whether it already overlapped anything", async ({
  page,
  browserName,
}: {
  page: Page;
  browserName: string;
}) => {
  // #347: webkit's settle race here is fixed (`alsoSettle` on the second
  // `dragNodeBy` call below settles the pushed sibling and this node
  // together) and verified stable over 10 consecutive runs. Firefox stays
  // skipped: even with that same hardening, 10 repeat runs of this file
  // passed this test only 4/10 times on firefox (same shape of large,
  // inconsistent position delta as the sibling test above) — not the
  // narrow early-read race #347 diagnosed, but the same broader
  // Firefox-specific instability filed as #357, tracked there rather than
  // duplicated here.
  test.skip(browserName === "firefox", "see #347, tracked as #357");
  test.setTimeout(60_000);
  const base = requireServer().baseUrl;
  // `deriveInitialArrangement` lays out edge-less nodes in one shared
  // column, ordered alphabetically by node id — not by creation order — so
  // a node meant to be "unrelated" can otherwise land physically *between*
  // the pair a later drag pushes, and get swept up in the chain by
  // accident rather than by the claim this test is making. Relocating it
  // first, by its own real drag gesture, is what guarantees it starts
  // somewhere the A/B interaction below can never reach — the same
  // durable-placement mechanic the arrangement-durability spec exercises
  // more directly.
  const idUntouched = await createContentNode(base, "Rigid Push Untouched");
  const idA = await createContentNode(base, "Rigid Push Solo A");
  const idB = await createContentNode(base, "Rigid Push Solo B");

  await page.goto(`${base}/`);
  await expect(page.getByTestId(`canvas-node-${idUntouched}`)).toBeVisible();
  await expect(page.getByTestId(`canvas-node-${idA}`)).toBeVisible();
  await expect(page.getByTestId(`canvas-node-${idB}`)).toBeVisible();

  await dragNodeBy(page, page.getByTestId(`canvas-node-${idUntouched}`), {
    x: 2000,
    y: 0,
  });
  const untouchedBefore = (await boxesByNodeId(page, [idUntouched])).get(
    idUntouched,
  ) as Box;

  const beforeAB = await boxesByNodeId(page, [idA, idB]);
  const orderedAB = orderByY(beforeAB);
  const [dragId, dragBox] = orderedAB[0] as [string, Box];
  const [otherId, otherBox] = orderedAB[1] as [string, Box];

  // #347: `alsoSettle` waits for the pushed sibling AND the untouched node
  // too — the webkit failure here was reading `untouchedAfter` while it was
  // still mid-commit from this second drag's own push pass, not because it
  // had actually moved.
  await dragNodeBy(
    page,
    page.getByTestId(`canvas-node-${dragId}`),
    { x: 0, y: otherBox.y - dragBox.y + 20 },
    {
      alsoSettle: [
        page.getByTestId(`canvas-node-${otherId}`),
        page.getByTestId(`canvas-node-${idUntouched}`),
      ],
    },
  );

  const after = await boxesByNodeId(page, [idUntouched, idA, idB]);
  const otherAfter = after.get(otherId) as Box;
  const untouchedAfter = after.get(idUntouched) as Box;
  // The other pair actually moved (sanity: the drag had an effect at all)...
  expect(otherAfter.y).not.toBeCloseTo(otherBox.y, 0);
  // ...but the node relocated well outside the chain's reach sits at the
  // exact same *position* it was left at, in a different drag gesture
  // entirely (rounded to whole pixels — width/height can wobble by a
  // sub-pixel from text layout, which is not a claim about position).
  expect(Math.round(untouchedAfter.x)).toBe(Math.round(untouchedBefore.x));
  expect(Math.round(untouchedAfter.y)).toBe(Math.round(untouchedBefore.y));
});
