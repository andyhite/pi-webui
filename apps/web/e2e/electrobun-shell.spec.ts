/**
 * THE ELECTROBUN SHELL SPIKE (#84, gating the post-M1 revisit of #78(c)).
 *
 * Answers one question with a run rather than an argument: can the
 * Playwright canvas e2e suite drive an Electrobun window? Losing that suite
 * was named as an unacceptable price for toolchain unification, so the
 * shell decision needs this answered before it is taken, not after.
 *
 * What this proves, end to end:
 *
 *   1. A minimal Electrobun app — built here, from a generated config and a
 *      four-line entrypoint — loads PlotRoom's *own* served page from a
 *      real spawned `@plotroom/server` (single origin, spec §12), with no
 *      renderer change of any kind for the shell. "Never fork the UI per
 *      target" survives.
 *   2. Playwright attaches to that window over CDP and drives it: the
 *      canvas renders a node this test seeded through the API, and the node
 *      is asserted through an ordinary `getByTestId` locator — the same
 *      call every existing canvas gate makes.
 *   3. The engine driven is the bundled CEF Chromium, not a Playwright-
 *      launched browser. That distinction is the entire point: a passing
 *      assertion against a browser Playwright started itself would prove
 *      nothing about the shell.
 *
 * Deliberately outside the default e2e gate (`playwright.config.ts`
 * `testIgnore`s it): it downloads ~210MB of Electrobun CLI, core and CEF
 * tarballs on a cold scratch directory, needs `bun` and an X display, and
 * exercises a shell the stack has not adopted. Run it explicitly:
 *
 *   pnpm build && pnpm --filter @plotroom/web e2e:electrobun
 *
 * The findings, including the two things that do NOT work, are recorded in
 * `docs/decisions/0006-electrobun-under-playwright.md`.
 */
import { expect, test } from "@playwright/test";

import {
  startElectrobunShell,
  unsupportedReason,
  type ElectrobunShell,
} from "./electrobun-shell-harness.js";
import {
  apiPost,
  ephemeralPort,
  startMilestoneServer,
  type MilestoneServer,
} from "./server-harness.js";

let server: MilestoneServer | undefined;
let shell: ElectrobunShell | undefined;

test.afterAll(async () => {
  if (shell) await shell.stop();
  if (server) await server.stop();
});

test("Playwright drives PlotRoom's canvas inside an Electrobun window over CDP", async () => {
  const unsupported = unsupportedReason();
  test.skip(unsupported !== undefined, unsupported ?? "");

  // A cold run downloads the framework and builds a CEF bundle before the
  // window even opens.
  test.setTimeout(15 * 60_000);

  server = await startMilestoneServer();
  const base = server.baseUrl;

  // One node, seeded the way every canvas gate seeds one, so what the
  // window renders is real PlotRoom state rather than a fixture page.
  const object = await apiPost<{ object: { id: string } }>(
    base,
    "/api/objects",
    {
      kind: "ticket",
      title: "Electrobun shell spike ticket",
      renderings: {
        card: {},
        summary: "Electrobun shell spike ticket",
        agentContent: "context for the Electrobun shell spike",
      },
    },
  );
  const node = await apiPost<{ node: { id: string } }>(base, "/api/nodes", {
    role: "content",
    refId: object.object.id,
  });
  const nodeId = node.node.id;

  shell = await startElectrobunShell(`${base}/`, await ephemeralPort());
  const { page } = shell;

  // (3) first, because every assertion below is only interesting if this
  // holds. What makes the attached engine *this app's* is provenance, not a
  // version string: the CDP port is parsed out of the `DevTools listening
  // on …` banner the app's own child process printed, so the endpoint is
  // definitionally the window's. The version equality below corroborates
  // that — it would catch an attachment that landed on some other Chromium
  // — and it is written against the bundle's own recorded `cefVersion` so a
  // future CEF bump keeps it honest rather than dating it. It is not
  // independent proof: it would pass silently if Playwright's bundled
  // Chromium ever matched CEF's version exactly.
  expect(shell.browserVersion).toBe(shell.bundledChromiumVersion);
  expect(await page.evaluate(() => navigator.userAgent)).not.toContain(
    "HeadlessChrome",
  );
  expect(await page.evaluate(() => location.origin)).toBe(base);

  // (1) and (2): the renderer PlotRoom serves, rendering a real node, read
  // through the same locator the browser-target canvas gates use.
  const canvasNode = page.getByTestId(`canvas-node-${nodeId}`);
  await expect(canvasNode).toBeVisible({ timeout: 60_000 });
  await expect(canvasNode).toContainText("Electrobun shell spike ticket");

  // xyflow itself mounted — a node div could in principle render without
  // the canvas around it, and the spec's harder canvas requirements all
  // sit on top of xyflow.
  await expect(page.locator(".react-flow__pane")).toBeVisible();

  // Driving, not just reading: a real interaction Playwright issues into
  // the CEF window changes what the canvas reports about itself.
  const zoomLevel = page.getByTestId("zoom-level");
  await expect(zoomLevel).not.toBeEmpty();
  const before = await zoomLevel.textContent();
  await page.locator(".react-flow__pane").hover();
  for (let step = 0; step < 30; step += 1) {
    if ((await zoomLevel.textContent()) !== before) break;
    await page.mouse.wheel(0, 200);
  }
  expect(await zoomLevel.textContent()).not.toBe(before);
});
