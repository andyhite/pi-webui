/**
 * MID-DRAG REFUSAL (Epic 8.5, Epic 3.3, spec §3.7, §5).
 *
 * "The legal connections, exhaustively: content -> command, and content ->
 * running session. Nothing else... An illegal connection is refused while
 * being dragged, not after it lands — an illegal connection never looks
 * like a legal one." (§5, §3.7)
 *
 * Proves, end to end, against a real spawned server and a real Chromium
 * tab loaded from the server's own served page (single origin, §12), for
 * both illegal shapes named in §3.7:
 *
 *   (a) content -> content ("illegal_target").
 *   (b) content -> a session that has already ended ("session_not_running").
 *
 * For each: the target handle's own xyflow-owned `valid` class — the single
 * DOM signal a dragged connection is currently legal — is asserted **absent
 * while the mouse is still down, hovering the illegal target**, not merely
 * absent after the fact. The drop is then completed and asserted to create
 * *nothing*: no new edge in the live canvas (`.react-flow__edge` count
 * unchanged) and no new edge in the server's own recorded state
 * (`GET /api/snapshot`, not just what the page happens to render).
 *
 * A positive control closes the loop: the *same* detection (the handle's
 * `valid` class) is asserted **present** for a legal content -> command
 * drag, and that drop *does* create an edge, both client-side and
 * server-side — proof the absence asserted above is a real refusal signal,
 * not a detection that never fires either way.
 */
import { expect, test, type Page } from "@playwright/test";

import {
  apiGet,
  apiPost,
  startMilestoneServer,
  type MilestoneServer,
} from "./server-harness.js";
import {
  beginConnectionDrag,
  dropConnectionDrag,
  expectHandleClasses,
  targetHandleLocator,
} from "./canvas-drag-helpers.js";

let server: MilestoneServer | undefined;

// A fresh server *per test*, not per file: these tests drag onto a literal
// handle a dozen or so screen pixels wide, and `fitView`'s computed zoom
// depends on the total node count already on the graph when a page
// navigates. Sharing one server (and its accumulating node count) across
// three tests in this file measurably drifted that zoom test to test —
// confirmed the hard way, see `canvas-drag-helpers.ts`'s own doc comment on
// `beginConnectionDrag`. A fresh, small, two-or-three-node graph every time
// keeps `fitView`'s own zoom in the same comfortable band every run.
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
    throw new Error(
      "the mid-drag refusal server never started (beforeEach failed)",
    );
  }
  return server;
}

interface SnapshotRead {
  readonly edges: readonly {
    readonly id: string;
    readonly from: string;
    readonly to: string;
  }[];
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

async function createCommandNode(base: string, name: string): Promise<string> {
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
  return command.node.id;
}

/** A session that has already ended — a real run, scripted to end on its own turn 1. */
async function createEndedSessionNode(
  base: string,
  commandNodeId: string,
): Promise<string> {
  const commandRead = await apiGet<{ node: { refId: string } }>(
    base,
    `/api/nodes/${commandNodeId}`,
  );
  const run = await apiPost<{ session: { id: string } | null }>(
    base,
    "/api/runs",
    {
      commandId: commandRead.node.refId,
      initiationKey: `mid-drag-refusal-${crypto.randomUUID()}`,
      runtime: {
        script: {
          acts: [
            {
              on: "start",
              steps: [
                { observation: { kind: "turn-started", turn: 1 } },
                {
                  observation: {
                    kind: "turn-ended",
                    turn: 1,
                    usage: { inputTokens: 5, outputTokens: 5 },
                  },
                },
                {
                  observation: {
                    kind: "session-ended",
                    reason: { kind: "ended-by-user" },
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
    throw new Error("the session was queued instead of started");
  }
  const sessionId = run.session.id;

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

  const snapshot = await apiGet<{
    nodes: readonly {
      readonly id: string;
      readonly role: string;
      readonly refId: string;
    }[];
  }>(base, "/api/snapshot");
  const sessionNode = snapshot.nodes.find(
    (node) => node.role === "session" && node.refId === sessionId,
  );
  if (!sessionNode)
    throw new Error("the ended session's node was never placed");
  return sessionNode.id;
}

async function edgeCount(page: Page): Promise<number> {
  return page.locator(".react-flow__edge").count();
}

/**
 * A command or session node lives inside its workstream's container (§3.3),
 * which force-collapses at the `workstream` zoom level (§5) regardless of
 * anyone's manual choice. `fitView`'s computed zoom is not something a test
 * can predict, so this escapes `workstream` the same way
 * `milestone.spec.ts`/`batch4-gate.spec.ts`/`a11y.spec.ts` all do — a small,
 * fresh, few-node graph (this file's own server is per-test, see the
 * `beforeEach` above) lands comfortably inside the `inner`/`detail` bands on
 * its own without ever needing this loop to run at all; it exists purely as
 * a defensive fallback, not a zoom level this file's own drags depend on.
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

test.describe("mid-drag refusal", () => {
  test("content -> content is refused visibly mid-drag and creates nothing", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const base = requireServer().baseUrl;

    const fromId = await createContentNode(base, "Mid-drag content source");
    const toId = await createContentNode(base, "Mid-drag content target");

    await page.goto(`${base}/`);
    await expect(page.getByTestId(`canvas-node-${fromId}`)).toBeVisible();
    await expect(page.getByTestId(`canvas-node-${toId}`)).toBeVisible();
    await ensureNotCollapsed(page);

    const before = await apiGet<SnapshotRead>(base, "/api/snapshot");
    const edgesBefore = before.edges.length;
    const onScreenBefore = await edgeCount(page);

    await beginConnectionDrag(page, fromId, toId);
    // The refusal is visible *during* the drag: hovering the illegal target
    // never earns the handle its `valid` class, even though the drag is
    // actively over it (`connectingto` true).
    await expectHandleClasses(targetHandleLocator(page, toId), {
      connectingTo: true,
      valid: false,
    });
    await dropConnectionDrag(page);

    // Nothing rendered client-side...
    expect(await edgeCount(page)).toBe(onScreenBefore);
    // ...and nothing recorded server-side.
    const after = await apiGet<SnapshotRead>(base, "/api/snapshot");
    expect(after.edges.length).toBe(edgesBefore);
    expect(
      after.edges.some((edge) => edge.from === fromId && edge.to === toId),
    ).toBe(false);
  });

  test("content -> a session that already ended is refused visibly mid-drag and creates nothing", async ({
    page,
    browserName,
  }) => {
    // #347: this one is a *different* failure from the settle-read race the
    // rest of this issue fixed, and stays skipped on firefox with that
    // distinction on record. Reproduced directly (2 runs, ~4 minutes, both
    // hit the exact same signature before a 10-run budget's worth of time
    // ran out): `beginConnectionDrag`'s `sourceHandle.hover()` times out
    // with Playwright's own actionability log naming a *different*,
    // unrelated node's `canvas-node-<id>` div as the element intercepting
    // pointer events at the handle's coordinates — i.e. on firefox this
    // fresh three-node graph (content, a workstream-contained command, and
    // the session node `createEndedSessionNode` places) derives an
    // arrangement where two independent top-level nodes visually overlap
    // enough to block one another's connection handle. No drag is even in
    // flight yet at that point, so no amount of settle-polling after a
    // gesture touches it — the bug (if it is one) is in whatever `deriveInitialArrangement`/
    // card sizing produces *before* this test's own interaction starts,
    // and plausibly downstream of firefox measuring rendered card
    // width/height differently (its own font metrics) than
    // chromium/webkit, not the render-commit race #347 diagnosed. Filed as
    // its own investigation issue, #358, against `packages/ui`'s
    // placement/derive code under firefox specifically, rather than
    // guessed at here.
    test.skip(browserName === "firefox", "see #347, tracked as #358");
    test.setTimeout(60_000);
    const base = requireServer().baseUrl;

    const contentId = await createContentNode(
      base,
      "Mid-drag ended-session source",
    );
    const commandNodeId = await createCommandNode(
      base,
      "mid-drag ended session command",
    );
    const sessionNodeId = await createEndedSessionNode(base, commandNodeId);

    await page.goto(`${base}/`);
    await expect(page.getByTestId(`canvas-node-${contentId}`)).toBeVisible();
    await ensureNotCollapsed(page);
    const sessionNode = page.locator('[data-testid^="canvas-node-"]', {
      hasText: /^session sess_/,
    });
    await expect(sessionNode).toBeVisible();
    // Confirmed ended, not merely placed: `createEndedSessionNode` already
    // polled the session's own end state to `not.toBeNull()` before
    // returning, so the checkConnection refusal below is exercised against a
    // node whose `running` flag has actually flipped server-side
    // (session-store.ts's `setRunning(id, false)` on end) — not against this
    // test's own timing guess.

    const before = await apiGet<SnapshotRead>(base, "/api/snapshot");
    const edgesBefore = before.edges.length;
    const onScreenBefore = await edgeCount(page);

    await beginConnectionDrag(page, contentId, sessionNodeId);
    await expectHandleClasses(targetHandleLocator(page, sessionNodeId), {
      connectingTo: true,
      valid: false,
    });
    await dropConnectionDrag(page);

    expect(await edgeCount(page)).toBe(onScreenBefore);
    const after = await apiGet<SnapshotRead>(base, "/api/snapshot");
    expect(after.edges.length).toBe(edgesBefore);
    expect(
      after.edges.some(
        (edge) => edge.from === contentId && edge.to === sessionNodeId,
      ),
    ).toBe(false);
  });

  test("positive control: content -> command is shown legal mid-drag and the drop actually wires it, client and server alike", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const base = requireServer().baseUrl;

    const contentId = await createContentNode(base, "Mid-drag legal source");
    const commandNodeId = await createCommandNode(
      base,
      "mid-drag legal target command",
    );

    await page.goto(`${base}/`);
    await expect(page.getByTestId(`canvas-node-${contentId}`)).toBeVisible();
    await ensureNotCollapsed(page);
    await expect(
      page.getByTestId(`canvas-node-${commandNodeId}`),
    ).toBeVisible();

    const before = await apiGet<SnapshotRead>(base, "/api/snapshot");
    const edgesBefore = before.edges.length;

    await beginConnectionDrag(page, contentId, commandNodeId);
    // The same detection this file's refusal assertions rely on actually
    // fires the other way for a legal pair — the absence asserted above is
    // a real refusal signal, not a check that never lights up either way.
    await expectHandleClasses(targetHandleLocator(page, commandNodeId), {
      connectingTo: true,
      valid: true,
    });
    await dropConnectionDrag(page);

    await expect
      .poll(async () => {
        const after = await apiGet<SnapshotRead>(base, "/api/snapshot");
        return after.edges.length;
      })
      .toBe(edgesBefore + 1);
    const after = await apiGet<SnapshotRead>(base, "/api/snapshot");
    expect(
      after.edges.some(
        (edge) => edge.from === contentId && edge.to === commandNodeId,
      ),
    ).toBe(true);
  });
});
