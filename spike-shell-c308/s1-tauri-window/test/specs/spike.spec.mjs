// #308 S1-S3 evidence, Linux only. Drives the real Tauri window (WebKitGTK)
// over WebKitWebDriver/tauri-driver, pointed at a real, seeded
// @plotroom/server via tauri.conf.json's build.devUrl (debug-build config).
import { expect } from "@wdio/globals";

const NODE_ID = process.env.SPIKE_NODE_ID;
if (!NODE_ID) {
  throw new Error("SPIKE_NODE_ID env var is required (set by the runner)");
}

// The `zoom-level` test hook (packages/ui/src/canvas/PlotCanvas.tsx) is
// rendered `display: none` by design — every real canvas gate (a11y.spec.ts,
// canvas-drag-helpers.ts, canvas-zoom-containers.spec.ts) reads its
// `textContent`, never asserts it's displayed. Follow the same convention
// here rather than inventing a visibility check the hook was never meant to
// satisfy.
async function readZoomLevel() {
  return browser.execute(() => {
    const el = document.querySelector('[data-testid="zoom-level"]');
    return el ? el.textContent : null;
  });
}

describe("S1: Tauri window shows PlotRoom's canvas (Linux, WebKitGTK)", () => {
  it("opens the window and loads PlotRoom's real served page", async () => {
    const title = await browser.getTitle();
    expect(title).toContain("PlotRoom");
  });

  it("renders the seeded canvas node through the same testid every canvas gate uses", async () => {
    const canvasNode = await browser.$(
      `[data-testid="canvas-node-${NODE_ID}"]`,
    );
    await canvasNode.waitForDisplayed({ timeout: 20000 });
    expect(await canvasNode.getText()).toContain("Tauri shell spike ticket");
  });

  it("mounts the real xyflow canvas pane under the node", async () => {
    const pane = await browser.$(".react-flow__pane");
    await expect(pane).toBeDisplayed();
  });

  it("drags the seeded node via a real WDIO pointer gesture", async () => {
    const canvasNode = await browser.$(
      `[data-testid="canvas-node-${NODE_ID}"]`,
    );
    const before = await canvasNode.getLocation();

    // A single pointerMove after pointerDown is too coarse for xyflow's own
    // drag-start threshold under WebKitGTK's synthetic-input path — sample
    // the move in several steps, the same shape a real trackpad drag
    // produces.
    const steps = 12;
    const dx = 140;
    const dy = 90;
    const moveActions = Array.from({ length: steps }, (_, index) => ({
      type: "pointerMove",
      duration: 20,
      x: Math.round(before.x + 10 + (dx * (index + 1)) / steps),
      y: Math.round(before.y + 10 + (dy * (index + 1)) / steps),
    }));

    await browser.performActions([
      {
        type: "pointer",
        id: "finger1",
        parameters: { pointerType: "mouse" },
        actions: [
          {
            type: "pointerMove",
            duration: 0,
            x: before.x + 10,
            y: before.y + 10,
          },
          { type: "pointerDown", button: 0 },
          ...moveActions,
          { type: "pointerUp", button: 0 },
        ],
      },
    ]);
    await browser.releaseActions();
    await browser.pause(300);

    const after = await canvasNode.getLocation();
    const moved =
      Math.abs(after.x - before.x) > 5 || Math.abs(after.y - before.y) > 5;
    expect(moved).toBe(true);
  });

  it("zooms the canvas via a real WDIO wheel gesture", async () => {
    const before = await readZoomLevel();

    const pane = await browser.$(".react-flow__pane");
    await pane.moveTo();
    const rect = await pane.getLocation();

    // A single-node graph's initial fitView often lands at the most
    // zoomed-in bucket already, so zooming further in (negative deltaY)
    // has nowhere to go. Zoom out (positive deltaY) instead - guaranteed
    // room to move away from whichever bucket the canvas started in.

    // One wheel tick changes the continuous scale but may not cross the
    // discrete zoom-level bucket boundary the hook reports - the product's
    // own canvas-zoom-containers.spec.ts steps the real interaction
    // repeatedly for exactly this reason (`zoomStepUntil`). Do the same:
    // real, discrete wheel ticks, checked after each one, never a fixed
    // jump assumed to land past a boundary.
    let after = before;
    for (let step = 0; step < 40 && after === before; step += 1) {
      await browser.performActions([
        {
          type: "wheel",
          id: "wheel1",
          actions: [
            {
              type: "scroll",
              x: Math.round(rect.x + 400),
              y: Math.round(rect.y + 300),
              deltaX: 0,
              deltaY: 120,
            },
          ],
        },
      ]);
      await browser.releaseActions();
      // The async-wheel path this spike exists to exercise commits its zoom
      // on its own schedule - give each tick a moment before checking.
      await browser.pause(150);
      after = await readZoomLevel();
    }
    expect(after).not.toBe(before);
  });
});

describe("S3: one real @wdio/tauri-service assertion (window + canvas node + IPC round trip)", () => {
  it("opens the window, sees the seeded canvas node, and completes one Tauri IPC round trip", async () => {
    // Window opens + real page loaded (not a Playwright-launched browser -
    // this session is WebKitWebDriver attached to the actual WebKitGTK
    // webview the Tauri binary created).
    expect(await browser.getTitle()).toContain("PlotRoom");

    // The seeded canvas node is visible, through the real render tree.
    const canvasNode = await browser.$(
      `[data-testid="canvas-node-${NODE_ID}"]`,
    );
    await canvasNode.waitForDisplayed({ timeout: 20000 });

    // One IPC round trip: invoke the scaffold's own `greet` Tauri command
    // through window.__TAURI__ (exposed via tauri.conf.json's
    // withGlobalTauri) and assert on the real Rust-side response.
    const result = await browser.execute(() => {
      return window.__TAURI__.core.invoke("greet", { name: "wdio-spike" });
    });
    expect(result).toBe("Hello, wdio-spike! You've been greeted from Rust!");
  });
});
