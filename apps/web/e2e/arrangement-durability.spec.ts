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
import { dragNodeBy, flowPosition } from "./canvas-drag-helpers.js";

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

/**
 * xyflow's own logical position for a node, rounded to a tenth of a pixel
 * (CSS serializes `translate()` at limited precision, while the write path
 * sends the server a full-precision float, so "the same position" has to
 * mean "the same to a small tolerance", never bit-for-bit) — delegates the
 * actual parsing to the shared `flowPosition` (`canvas-drag-helpers.ts`),
 * which also covers Firefox's own single-argument `translate(Xpx)`
 * serialization when a node's y offset is exactly zero.
 */
async function readNodePosition(
  page: Page,
  nodeId: string,
): Promise<{ x: number; y: number }> {
  return roundPoint(
    await flowPosition(page.locator(`[data-testid="rf__node-${nodeId}"]`)),
  );
}

/**
 * `readAuthoredPosition` (the server, a `PATCH`ed float64 round-tripped
 * through JSON, no precision lost) and `readNodePosition` (the DOM,
 * `style.transform`'s string re-serialized *out of the browser's own CSS
 * engine*) start from the same conceptual value but do not preserve it
 * identically: browsers store `transform`'s components at `float` (32-bit)
 * precision internally, not JavaScript's `double`, so reading a translated
 * position back out of the DOM is a lossy round-trip the server's side of
 * the same comparison never takes. That loss is usually far below
 * `roundPoint`'s own tenth-of-a-pixel bucket — invisible — except when the
 * true value sits within a float32 ULP of a bucket's own boundary, where it
 * can nudge the DOM's read onto the *other* side of that boundary from the
 * server's exact one. The two sides then round to *adjacent* tenths of a
 * pixel forever: not a race either value is still converging out of (caught
 * live while diagnosing this fix — server 86.7, DOM 86.8, both for the same
 * drag, https://github.com/andyhite/plotroom/issues/365), so no amount of
 * `expect.poll` waiting was ever going to close it. A tolerance one bucket
 * wide absorbs exactly that cross-representation slop and nothing more —
 * still sharp enough to fail on a genuinely wrong position.
 */
function samePosition(
  a: { x: number; y: number },
  b: { x: number; y: number },
): boolean {
  return Math.abs(a.x - b.x) <= 0.15 && Math.abs(a.y - b.y) <= 0.15;
}

async function boundingBoxOrThrow(
  page: Page,
  nodeId: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.getByTestId(`canvas-node-${nodeId}`).boundingBox();
  if (!box) throw new Error(`node ${nodeId} has no bounding box`);
  return box;
}

/**
 * Drags `nodeId` until its pointer lands on `targetNodeId`'s *original*
 * center — enough overlap to force the rigid-body push solver to displace
 * it. Settles the target too (`alsoSettle`, shared `dragNodeBy`'s own
 * hardening, #347): the pushed neighbour can still be mid-commit after the
 * dragged node's own box has already stopped moving.
 */
async function dragNodeOnto(
  page: Page,
  nodeId: string,
  targetNodeId: string,
): Promise<void> {
  const source = await boundingBoxOrThrow(page, nodeId);
  const target = await boundingBoxOrThrow(page, targetNodeId);
  await dragNodeBy(
    page,
    page.getByTestId(`canvas-node-${nodeId}`),
    {
      x: target.x + target.width / 2 - (source.x + source.width / 2),
      y: target.y + target.height / 2 - (source.y + source.height / 2),
    },
    { alsoSettle: [page.getByTestId(`canvas-node-${targetNodeId}`)] },
  );
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

        await dragNodeBy(page, page.getByTestId(`canvas-node-${nodeId}`), {
          x: 260,
          y: 180,
        });
        const draggedTo = await readNodePosition(page, nodeId);

        // The write is debounced (`createArrangementWriteQueue`); wait for
        // the server to actually have it rather than racing the debounce
        // window with a fixed sleep.
        await expect
          .poll(async () => {
            const authored = await readAuthoredPosition(server.baseUrl, nodeId);
            return authored && samePosition(authored, draggedTo)
              ? draggedTo
              : authored;
          })
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
        .poll(async () => {
          const authored = {
            a: await readAuthoredPosition(server.baseUrl, a.nodeId),
            b: await readAuthoredPosition(server.baseUrl, b.nodeId),
          };
          const expected = { a: afterPushA, b: afterPushB };
          return authored.a &&
            authored.b &&
            samePosition(authored.a, afterPushA) &&
            samePosition(authored.b, afterPushB)
            ? expected
            : authored;
        })
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

      await dragNodeBy(page, page.getByTestId(`canvas-node-${nodeId}`), {
        x: 220,
        y: 140,
      });
      const draggedTo = await readNodePosition(page, nodeId);

      await expect
        .poll(async () => {
          const authored = await readAuthoredPosition(server.baseUrl, nodeId);
          return authored && samePosition(authored, draggedTo)
            ? draggedTo
            : authored;
        })
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
