/**
 * THE SEARCH/SETTINGS/LOGS GATE (Epic 8.2/8.3).
 *
 * Proves, end to end, against a real spawned server (`PLOTROOM_RUNTIME=
 * scripted`) and a real local git repository, loaded as the server's own
 * served page (single origin, spec §12) in a real Chromium tab:
 *
 *   (a) **Search (§6.8).** A session is findable by its command's title,
 *       and once its workstream is archived the same hit still appears —
 *       reported as archived, never hidden. Selecting it navigates through
 *       the one selection-as-route primitive: the address itself names the
 *       session afterward, over `GET /api/search` (operator-only).
 *   (b) **Settings (§11).** Writing a live-applying setting (`PUT
 *       /api/settings/:key`) is reflected on the server immediately and
 *       renders honestly as "applies without a restart"; "remove override"
 *       (`DELETE`) reverts it to the catalog default — a distinct verb from
 *       writing an empty value.
 *   (c) **Logs (§8).** The structured log's own request lines are
 *       queryable and filterable by component; a filter that matches
 *       nothing renders the panel's own honest empty state rather than
 *       stale rows from the previous filter.
 *
 * Run locally: `pnpm build && pnpm --filter @plotroom/web e2e` (root
 * `pnpm build` — or at least `@plotroom/core`, `@plotroom/ui`,
 * `@plotroom/server`, and `@plotroom/web` — must have already produced
 * `apps/server/dist` and `apps/web/dist`).
 */
import { expect, test } from "@playwright/test";

import {
  apiGet,
  apiPost,
  startMilestoneServer,
  type MilestoneServer,
} from "./server-harness.js";

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
      "the search/settings/logs gate's server never started (beforeAll failed)",
    );
  }
  return server;
}

async function createDefinition(base: string, name: string): Promise<string> {
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
  return definition.definition.id;
}

test.describe("search, settings, and logs", () => {
  test("a hit is findable, then still findable and honestly archived, and selecting it is the one navigation primitive", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const base = requireServer().baseUrl;
    const marker = `e2e-search-marker-${crypto.randomUUID().slice(0, 8)}`;
    const definitionId = await createDefinition(base, `fix the ${marker} bug`);
    const workstream = await apiPost<{ workstream: { id: string } }>(
      base,
      "/api/workstreams",
      {},
    );
    const command = await apiPost<{ command: { id: string } }>(
      base,
      "/api/commands",
      { definitionId, workstreamId: workstream.workstream.id },
    );
    const run = await apiPost<{ session: { id: string } | null }>(
      base,
      "/api/runs",
      {
        commandId: command.command.id,
        initiationKey: `search-e2e-${crypto.randomUUID()}`,
      },
    );
    if (run.session === null) {
      throw new Error("the search fixture session was queued, not started");
    }
    const sessionId = run.session.id;

    await page.goto(`${base}/`);
    await expect(page.getByTestId("attention-header-count")).toBeVisible();

    await page.getByRole("button", { name: "Search", exact: true }).click();
    const searchInput = page.getByTestId("search-panel-input");
    await searchInput.fill(marker);

    const results = page.getByTestId("search-panel-results");
    await expect(results.getByTestId("search-result")).toHaveCount(1, {
      timeout: 15_000,
    });
    await expect(results.getByTestId("search-result-archived")).toHaveCount(0);

    // Archive the session's workstream — §6.8: the hit stays a row,
    // reported as archived, never removed from the list.
    await apiPost(
      base,
      `/api/workstreams/${workstream.workstream.id}/archive`,
      {},
    );
    await searchInput.fill("");
    await searchInput.fill(marker);
    await expect(results.getByTestId("search-result-archived")).toHaveCount(1, {
      timeout: 15_000,
    });

    // Selecting the hit is the one selection-as-route primitive: the
    // address itself now names the session, exactly like a canvas click.
    await results.getByTestId("search-result").getByRole("button").click();
    await expect
      .poll(() => page.evaluate(() => window.location.search))
      .toContain(sessionId);
  });

  test("a live-applying setting writes through immediately, and 'remove override' is its own verb", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const base = requireServer().baseUrl;

    await page.goto(`${base}/`);
    await expect(page.getByTestId("attention-header-count")).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();

    await page.getByTestId("settings-search-input").fill("Concurrency limit");
    await page.getByTestId("settings-row-concurrencyLimit").click();

    await expect(page.getByTestId("settings-restart-status")).toHaveText(
      "applies without a restart",
    );

    const valueInput = page.getByTestId("settings-value-input");
    await valueInput.fill("");
    await valueInput.fill("7");
    await page.getByTestId("settings-save").click();

    await expect
      .poll(async () => {
        const read = await apiGet<{ setting: { value: unknown } }>(
          base,
          "/api/settings/concurrencyLimit",
        );
        return read.setting.value;
      })
      .toBe(7);
    await expect(page.getByTestId("settings-panel-live-region")).toContainText(
      "applied without a restart",
    );

    await page.getByTestId("settings-remove-override").click();
    await expect
      .poll(async () => {
        const read = await apiGet<{ setting: { overridden: boolean } }>(
          base,
          "/api/settings/concurrencyLimit",
        );
        return read.setting.overridden;
      })
      .toBe(false);
  });

  test("logs are queryable and a component filter that matches nothing shows the panel's own honest empty state", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const base = requireServer().baseUrl;

    // The gate's own server runs at "error" (quiet test output); lower it
    // through the Settings surface's own write path first — the same live
    // setting the Settings test above exercises — so an ordinary request
    // actually lands an "info" line in the ring buffer to query.
    await fetch(`${base}/api/settings/logLevel`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ value: "info" }),
    });
    // At least one real request line exists before the panel ever opens.
    await apiGet(base, "/api/health");

    await page.goto(`${base}/`);
    await expect(page.getByTestId("attention-header-count")).toBeVisible();
    await page.getByRole("button", { name: "Logs", exact: true }).click();
    await page.getByTestId("logs-refresh").click();

    await expect(
      page.locator('[data-testid^="log-entry-"]').first(),
    ).toBeVisible({
      timeout: 15_000,
    });

    await page
      .getByTestId("logs-component-filter")
      .fill("no-such-component-anywhere");
    await expect(
      page.getByText("no log entries match this filter"),
    ).toBeVisible();
    await expect(page.locator('[data-testid^="log-entry-"]')).toHaveCount(0);
  });
});
