/**
 * Arrangement durability (spec §5, §12; Epic 3.1's deferral — "the renderer
 * still writes to localStorage until it adopts those endpoints" — closed;
 * Epic 8.5's Playwright canvas e2e "arrangement durability" leg).
 *
 * Proves, through the real UI against a real spawned server, that the
 * server — never `localStorage` — is the source of truth for where a node
 * sits:
 *
 *   1. A drag persists through the real API (`PATCH /api/nodes/:id/
 *      position`), and the position survives a genuine server *restart*,
 *      read back from a brand new browser context sharing no storage of
 *      any kind with the one that dragged it — the sharp assertion the gap
 *      prevented until now (localStorage alone cannot cross a fresh
 *      context, so this cannot pass by accident the way it might have
 *      before).
 *   2. A rigid-body push during one drag gesture persists the displaced
 *      neighbour too, through the batch endpoint (`PATCH /api/
 *      arrangement`), one transaction for the whole settled arrangement.
 *   3. "Reset arrangement" goes through the server (`POST /api/reset`,
 *      scope `"arrangement"`): the authored position is actually gone from
 *      the durable record, not merely repainted on the one open tab.
 *
 * Coordinate-free by design: every assertion compares a position read back
 * from the DOM or the API against another read of the same kind, never a
 * literal expected coordinate — xyflow's own fitView/zoom choice is not
 * this suite's business to predict.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";

import {
  apiGet,
  apiPost,
  startMilestoneServer,
  type MilestoneServer,
} from "./server-harness.js";

/** A minimal real git repository — provisioning is never exercised here, but the server expects one configured. */
function initGitRepository(): string {
  const dir = mkdtempSync(join(tmpdir(), "plotroom-arrangement-e2e-repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });
  git("init", "--initial-branch", "main");
  git("config", "user.email", "e2e@plotroom.invalid");
  git("config", "user.name", "PlotRoom E2E");
  writeFileSync(join(dir, "README.md"), "# fixture\n", "utf8");
  git("add", ".");
  git("commit", "-m", "initial");
  return dir;
}

/**
 * xyflow's own logical position for a node — `data-testid="rf__node-<id>"`
 * is the library's own stable hook (`@xyflow/react`), and its `style`
 * attribute's `translate(Xpx,Ypx)` is the node's absolute flow-space
 * position, independent of the viewport's own pan/zoom (applied separately,
 * to the ancestor `.react-flow__viewport`) — reading it is what makes every
 * assertion in this file coordinate-free rather than assuming a zoom level.
 */
/**
 * CSS serializes the `translate()` at limited precision (a handful of
 * significant digits) while the value the write path actually sends the
 * server is a full-precision float, so "the same position" has to mean
 * "the same to a small tolerance", never bit-for-bit — rounding every
 * position this file reads, from either source, to a tenth of a pixel
 * (visually meaningless, well inside CSS's own rounding error) is what
 * keeps every comparison honest instead of coincidentally exact.
 */
function roundPoint(point: { x: number; y: number }): {
  x: number;
  y: number;
} {
  return {
    x: Math.round(point.x * 10) / 10,
    y: Math.round(point.y * 10) / 10,
  };
}

async function readNodePosition(
  page: Page,
  nodeId: string,
): Promise<{ x: number; y: number }> {
  const style = await page
    .locator(`[data-testid="rf__node-${nodeId}"]`)
    .getAttribute("style");
  const match = style?.match(/translate\(([-0-9.]+)px,\s*([-0-9.]+)px\)/);
  if (!match) {
    throw new Error(
      `could not read a translate() out of node ${nodeId}'s style: ${style}`,
    );
  }
  return roundPoint({ x: Number(match[1]), y: Number(match[2]) });
}

async function boundingBoxOrThrow(
  page: Page,
  nodeId: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.getByTestId(`canvas-node-${nodeId}`).boundingBox();
  if (!box) throw new Error(`node ${nodeId} has no bounding box`);
  return box;
}

/** A real mouse-driven drag of a canvas node — xyflow's own drag handling responds to genuine pointer input, not the HTML5 DnD `milestone.spec.ts` uses for palette drops. */
async function dragNodeBy(
  page: Page,
  nodeId: string,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  const box = await boundingBoxOrThrow(page, nodeId);
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + deltaX, startY + deltaY, { steps: 10 });
  await page.mouse.up();
}

/** Drags `nodeId` until its pointer lands on `targetNodeId`'s *original* center — enough overlap to force the rigid-body push solver to displace it. */
async function dragNodeOnto(
  page: Page,
  nodeId: string,
  targetNodeId: string,
): Promise<void> {
  const source = await boundingBoxOrThrow(page, nodeId);
  const target = await boundingBoxOrThrow(page, targetNodeId);
  await page.mouse.move(
    source.x + source.width / 2,
    source.y + source.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    target.x + target.width / 2,
    target.y + target.height / 2,
    {
      steps: 10,
    },
  );
  await page.mouse.up();
}

async function seedTicketNode(
  baseUrl: string,
  title: string,
): Promise<{ readonly objectId: string; readonly nodeId: string }> {
  const object = await apiPost<{ object: { id: string } }>(
    baseUrl,
    "/api/objects",
    {
      kind: "ticket",
      title,
      renderings: { card: {}, summary: title, agentContent: "n/a" },
    },
  );
  const node = await apiPost<{ node: { id: string } }>(baseUrl, "/api/nodes", {
    role: "content",
    refId: object.object.id,
  });
  return { objectId: object.object.id, nodeId: node.node.id };
}

async function readAuthoredPosition(
  baseUrl: string,
  nodeId: string,
): Promise<{ x: number; y: number } | null> {
  const read = await apiGet<{
    node: { position: { x: number; y: number } | null };
  }>(baseUrl, `/api/nodes/${nodeId}`);
  return read.node.position === null ? null : roundPoint(read.node.position);
}

/** One server, one call, torn down (process + scratch directories) no matter how the callback ends. */
async function withFreshServer<T>(
  run: (server: MilestoneServer) => Promise<T>,
): Promise<T> {
  const stateDir = mkdtempSync(
    join(tmpdir(), "plotroom-arrangement-e2e-state-"),
  );
  mkdirSync(join(stateDir, "workspaces"), { recursive: true });
  const repositoryPath = initGitRepository();
  const server = await startMilestoneServer({ stateDir, repositoryPath });
  try {
    return await run(server);
  } finally {
    await server.stop();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(repositoryPath, { recursive: true, force: true });
  }
}

test.describe("arrangement durability (§5, §12)", () => {
  test("a dragged node's position survives a server restart, read back in a brand new browser context", async ({
    page,
    browser,
  }) => {
    const stateDir = mkdtempSync(
      join(tmpdir(), "plotroom-arrangement-e2e-state-"),
    );
    mkdirSync(join(stateDir, "workspaces"), { recursive: true });
    const repositoryPath = initGitRepository();

    try {
      let server = await startMilestoneServer({ stateDir, repositoryPath });
      try {
        const { nodeId } = await seedTicketNode(
          server.baseUrl,
          "OXY-8001 arrangement durability fixture",
        );

        await page.goto(`${server.baseUrl}/`);
        await expect(page.getByTestId(`canvas-node-${nodeId}`)).toBeVisible();

        await dragNodeBy(page, nodeId, 260, 180);
        const draggedTo = await readNodePosition(page, nodeId);

        // The write is debounced (`createArrangementWriteQueue`); wait for
        // the server to actually have it rather than racing the debounce
        // window with a fixed sleep.
        await expect
          .poll(() => readAuthoredPosition(server.baseUrl, nodeId))
          .toEqual(draggedTo);

        await server.stop();
        server = await startMilestoneServer({ stateDir, repositoryPath });

        const freshContext = await browser.newContext();
        try {
          const freshPage = await freshContext.newPage();
          await freshPage.goto(`${server.baseUrl}/`);
          await expect(
            freshPage.getByTestId(`canvas-node-${nodeId}`),
          ).toBeVisible();

          const afterRestart = await readNodePosition(freshPage, nodeId);
          expect(afterRestart).toEqual(draggedTo);
        } finally {
          await freshContext.close();
        }
      } finally {
        await server.stop();
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(repositoryPath, { recursive: true, force: true });
    }
  });

  test("a rigid-body push during one drag persists the displaced neighbour too, via PATCH /api/arrangement", async ({
    page,
  }) => {
    await withFreshServer(async (server) => {
      const a = await seedTicketNode(server.baseUrl, "OXY-8002a push fixture");
      const b = await seedTicketNode(server.baseUrl, "OXY-8002b push fixture");

      await page.goto(`${server.baseUrl}/`);
      await expect(page.getByTestId(`canvas-node-${a.nodeId}`)).toBeVisible();
      await expect(page.getByTestId(`canvas-node-${b.nodeId}`)).toBeVisible();

      const beforePush = await readNodePosition(page, b.nodeId);

      // Drag A directly onto B: the rigid-body push solver displaces B in
      // the same gesture (§5) — the "several nodes at once" write path,
      // which persists through one `PATCH /api/arrangement` transaction
      // rather than a `PATCH /api/nodes/:id/position` per node.
      await dragNodeOnto(page, a.nodeId, b.nodeId);

      const afterPushA = await readNodePosition(page, a.nodeId);
      const afterPushB = await readNodePosition(page, b.nodeId);
      // The sharp negative: B genuinely moved (the push happened), never
      // asserted as a literal coordinate.
      expect(afterPushB).not.toEqual(beforePush);

      await expect
        .poll(async () => ({
          a: await readAuthoredPosition(server.baseUrl, a.nodeId),
          b: await readAuthoredPosition(server.baseUrl, b.nodeId),
        }))
        .toEqual({ a: afterPushA, b: afterPushB });
    });
  });

  test("reset arrangement clears the authored position on the server, and the canvas re-derives", async ({
    page,
  }) => {
    await withFreshServer(async (server) => {
      const { nodeId } = await seedTicketNode(
        server.baseUrl,
        "OXY-8003 reset arrangement fixture",
      );

      await page.goto(`${server.baseUrl}/`);
      await expect(page.getByTestId(`canvas-node-${nodeId}`)).toBeVisible();

      await dragNodeBy(page, nodeId, 220, 140);
      const draggedTo = await readNodePosition(page, nodeId);

      await expect
        .poll(() => readAuthoredPosition(server.baseUrl, nodeId))
        .toEqual(draggedTo);

      await page.keyboard.press("Control+k");
      const combobox = page.getByRole("combobox", {
        name: "command palette query",
      });
      await expect(combobox).toBeVisible();
      await combobox.fill("reset arrangement");
      await page
        .getByRole("button", { name: "reset arrangement", exact: true })
        .click();

      // Durable, server-side (§5, §12): the authored position is gone from
      // the record a restart would read, not merely repainted differently
      // on this one open tab.
      await expect
        .poll(() => readAuthoredPosition(server.baseUrl, nodeId))
        .toBeNull();

      // And the canvas itself re-derived rather than leaving the node
      // wherever the drag left it.
      await expect
        .poll(() => readNodePosition(page, nodeId))
        .not.toEqual(draggedTo);
    });
  });
});
