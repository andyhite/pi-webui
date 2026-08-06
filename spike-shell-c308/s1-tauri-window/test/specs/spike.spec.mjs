// #308 S1-S3 evidence, Linux only. Drives the real Tauri window (WebKitGTK)
// over WebKitWebDriver/tauri-driver, pointed at a real, seeded
// @plotroom/server via tauri.conf.json's build.frontendDist URL override.
import { expect } from "@wdio/globals";

const NODE_ID = process.env.SPIKE_NODE_ID;
if (!NODE_ID) {
  throw new Error("SPIKE_NODE_ID env var is required (set by the runner)");
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
          {
            type: "pointerMove",
            duration: 200,
            x: before.x + 140,
            y: before.y + 90,
          },
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
    const zoomLevel = await browser.$('[data-testid="zoom-level"]');
    await zoomLevel.waitForDisplayed();
    const before = await zoomLevel.getText();

    const pane = await browser.$(".react-flow__pane");
    const rect = await pane.getLocation();

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
            deltaY: -400,
          },
        ],
      },
    ]);
    await browser.releaseActions();
    await browser.pause(300);

    const after = await zoomLevel.getText();
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
