/**
 * Shared, canvas-only e2e helpers: real mouse-driven node repositioning and
 * connection dragging. Distinct from `milestone.spec.ts`'s
 * `dragAndDropHtml5` (that one drives the palette's native HTML5
 * drag-and-drop, e.g. dropping a command definition onto a ticket) — moving
 * an already-placed node, and dragging a new edge off a handle, are xyflow's
 * own pointer-based drag interactions, driven here with real
 * `page.mouse` events so headless Chromium runs the exact same listener path
 * a human drag would.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function center(box: Box): { readonly x: number; readonly y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function requireBox(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("locator has no bounding box (not rendered?)");
  return box;
}

/**
 * Repositions an already-placed node by its own body (not a handle) — the
 * same gesture the rigid-body push solver and durable-placement persistence
 * both hang off (`onNodeDrag`/`onNodeDragStop` in `PlotCanvas.tsx`). Moves in
 * several intermediate steps so xyflow's own drag-threshold and per-frame
 * push solver both see real motion, not a single teleport.
 *
 * `alsoSettle`, when given, names every other node this gesture is expected
 * to disturb (a rigid-body push's siblings, a container's other children) —
 * `waitForSettled` below waits for *all* of them, dragged node included, to
 * stop moving together before returning. Settling only the dragged node's
 * own box (the original, narrower shape of this helper) is exactly the gap
 * #347 traced: a pushed sibling can still be mid-commit after the node under
 * the pointer has already stopped, and a caller that reads the sibling right
 * after `dragNodeBy` returns catches that stale frame.
 */
export async function dragNodeBy(
  page: Page,
  node: Locator,
  delta: { readonly x: number; readonly y: number },
  options?: { readonly alsoSettle?: readonly Locator[] },
): Promise<void> {
  const box = await requireBox(node);
  const start = center(box);
  const end = { x: start.x + delta.x, y: start.y + delta.y };

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  const steps = 8;
  for (let step = 1; step <= steps; step++) {
    await page.mouse.move(
      start.x + ((end.x - start.x) * step) / steps,
      start.y + ((end.y - start.y) * step) / steps,
      { steps: 2 },
    );
  }
  await page.mouse.up();
  await waitForSettled([node, ...(options?.alsoSettle ?? [])]);
}

/**
 * #317's browser matrix surfaced this: xyflow's own drag-driven repositioning
 * commits its final frame asynchronously relative to the dispatched
 * `mouseup` — reliably already flushed by the time Chromium's event loop
 * returns control to Playwright, but not guaranteed under WebKit's or
 * Firefox's own render scheduling (measured: reading a "settled" box
 * immediately after `mouse.up()` caught a stale, still-moving position on
 * Firefox often enough to fail rigid-body push assertions, and #347's
 * webkit escalation showed the same gap for a *pushed* node's box, and for a
 * node re-rendered fresh after a `page.reload()`). A bounded poll on every
 * given node's own box, not a fixed sleep — it converges on whatever the
 * DOM's true settled position is, on every engine, rather than masking a
 * real regression behind a wait that always passes.
 *
 * Exported (not just `dragNodeBy`'s own internal use) so a spec can also
 * settle nodes a gesture disturbed indirectly — a reload's fresh render, or
 * a second drag's push reaching a node the first call never named — before
 * reading their positions for an assertion.
 */
export async function waitForSettled(
  nodes: readonly Locator[],
  quietMs = 50,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = await Promise.all(nodes.map(requireBox));
  while (Date.now() < deadline) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, quietMs);
    await promise;
    const next = await Promise.all(nodes.map(requireBox));
    if (
      next.every(
        (box, i) =>
          Math.round(box.x) === Math.round(last[i]!.x) &&
          Math.round(box.y) === Math.round(last[i]!.y),
      )
    ) {
      return;
    }
    last = next;
  }
}

/**
 * Every top-level (uncontained) node's current screen bounding box, keyed by
 * its own `canvas-node-<id>` testid suffix — for reading positions back
 * after a push or a settle, without knowing screen coordinates in advance.
 */
export async function boxesByNodeId(
  page: Page,
  nodeIds: readonly string[],
): Promise<ReadonlyMap<string, Box>> {
  const result = new Map<string, Box>();
  for (const id of nodeIds) {
    result.set(id, await requireBox(page.getByTestId(`canvas-node-${id}`)));
  }
  return result;
}

/** True when two screen-space boxes overlap by more than a touching epsilon. */
export function overlaps(a: Box, b: Box, epsilon = 1): boolean {
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapY =
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return overlapX > epsilon && overlapY > epsilon;
}

/**
 * Begins a connection drag from a node's own source handle (right edge) and
 * holds the pointer over a target node's target handle (left edge) without
 * releasing — the mid-drag window §5's refusal must be visible inside.
 * Returns the still-held-down state so the caller can inspect the DOM, then
 * either drop (`page.mouse.up()`) or cancel (move away and release).
 *
 * The final approach onto each handle goes through the *locator's own*
 * `.hover()` rather than a coordinate computed once, earlier, and reused —
 * a handle is a dozen or so screen pixels wide, and a coordinate read
 * before a zoom/pan has fully settled (or before xyflow's own
 * `ResizeObserver`-driven remeasure lands) can be stale by the time the
 * pointer actually arrives, landing just outside the handle rather than on
 * it. `Locator.hover()` re-measures immediately before acting and waits for
 * the element's own actionability (attached, visible, stable, receiving
 * pointer events) first — the flake this file hit during development
 * disappeared once the target approach went through it instead of a
 * pre-computed point.
 */
export async function beginConnectionDrag(
  page: Page,
  fromNodeId: string,
  toNodeId: string,
): Promise<void> {
  const sourceHandle = page
    .getByTestId(`canvas-node-${fromNodeId}`)
    .locator(".react-flow__handle-right");
  const targetHandle = page
    .getByTestId(`canvas-node-${toNodeId}`)
    .locator(".react-flow__handle-left");

  await sourceHandle.hover();
  await page.mouse.down();
  // A real intermediate stop, roughly midway, so xyflow's connection
  // tracking sees actual pointer motion rather than a single jump — the
  // exact point does not matter, only that real mousemove events fire
  // between the source and the target.
  const sourceBox = await requireBox(sourceHandle);
  const targetBoxApprox = await requireBox(targetHandle);
  const midpoint = {
    x: (center(sourceBox).x + center(targetBoxApprox).x) / 2,
    y: (center(sourceBox).y + center(targetBoxApprox).y) / 2,
  };
  await page.mouse.move(midpoint.x, midpoint.y, { steps: 5 });
  // The precise final approach: re-measured right now, not reused from
  // above.
  await targetHandle.hover();
}

/** The target handle a connection drag is currently hovering, mid-drag. */
export function targetHandleLocator(page: Page, toNodeId: string): Locator {
  return page
    .getByTestId(`canvas-node-${toNodeId}`)
    .locator(".react-flow__handle-left");
}

/** Releases the mouse wherever it currently is — completing or refusing the drag depending on what is under it. */
export async function dropConnectionDrag(page: Page): Promise<void> {
  await page.mouse.up();
}

/**
 * A node's own flow-space position — xyflow renders each node with
 * `transform: translate(Xpx, Ypx)` in *flow* coordinates, entirely separate
 * from `.react-flow__viewport`'s own pan/zoom transform. Screen-space
 * bounding boxes (`boxesByNodeId` above) are only comparable *within* one
 * continuous page session: a `page.reload()` (or any fresh `page.goto()`)
 * re-runs `fitView`, which computes a *different* pan/zoom depending on
 * whatever the current arrangement's bounding box happens to be at that
 * moment — so the same flow position renders at different screen pixels
 * across a reload. Reading the node's own inline `transform` instead is
 * exactly the durable, authored position (§5) itself, independent of
 * whatever the viewport happens to be doing.
 */
export async function flowPosition(
  node: Locator,
): Promise<{ readonly x: number; readonly y: number }> {
  const transform = await node.evaluate((element) => {
    const styled = element as HTMLElement;
    return styled.style.transform;
  });
  // Firefox's CSSOM collapses `translate(Xpx, 0px)` down to the CSS
  // `translate()` function's single-argument form (`translate(Xpx)`,
  // Y implied zero) when the node's Y offset is exactly zero — Chromium and
  // WebKit always serialize both components. The second group is therefore
  // optional, defaulting to "0" rather than failing to parse at all.
  const match = /translate\(([-0-9.]+)px(?:,\s*([-0-9.]+)px)?\)/.exec(
    transform,
  );
  if (!match) {
    throw new Error(
      `could not parse a flow-space transform from "${transform}"`,
    );
  }
  return { x: Number(match[1]), y: Number(match[2] ?? 0) };
}

/**
 * Zooms in, one small real wheel tick at a time, until the canvas is past the
 * workstream zoom level — where a container is one card and its contents are
 * not rendered at all (§5), so anything about a contained node has to get past
 * it first. Steps rather than jumps because `fitView`'s computed zoom is not
 * predictable from a test, and one large tick can skip a level.
 *
 * Lives here because six spec files carry their own copy of this loop and
 * `canvas-zoom-containers.spec.ts` a seventh, more general one; this is the
 * shared home the rest should converge on.
 */
export async function zoomPastWorkstreamLevel(page: Page): Promise<void> {
  const zoomLevel = page.getByTestId("zoom-level");
  const pane = page.locator(".react-flow__pane");
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await zoomLevel.textContent()) !== "workstream") return;
    await pane.hover();
    await page.mouse.wheel(0, -120);
  }
  await expect(zoomLevel).not.toHaveText("workstream");
}

/** Asserts a handle's xyflow-owned class list carries exactly the given tokens' presence (mid-drag legality signal, spec §5). */
export async function expectHandleClasses(
  handle: Locator,
  expected: { readonly connectingTo: boolean; readonly valid: boolean },
): Promise<void> {
  const classList = (await handle.getAttribute("class")) ?? "";
  const tokens = new Set(classList.split(/\s+/).filter(Boolean));
  expect(tokens.has("connectingto")).toBe(expected.connectingTo);
  expect(tokens.has("valid")).toBe(expected.valid);
}
