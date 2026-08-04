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
 *   (d) **A panel says when a read failed.** An aborted `GET /api/search`,
 *       `GET /api/logs` or `GET /api/settings` is reported in the panel (and,
 *       for search and logs, in its live region) instead of leaving the
 *       previous query's rows standing as if they answered this one — a failed
 *       log read never renders as "no entries match this filter", which is a
 *       claim about the log, and the settings failure is reported *outside* the
 *       detail pane, which clearing the rows unmounts.
 *   (e) **A live change from elsewhere keeps the operator's filter**; an empty
 *       number field is refused rather than written as the zero `Number("")`
 *       is — on a setting whose zero the server accepts — and a save reseeds
 *       the field from what the write returned rather than leaving what was
 *       typed in it.
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

/** A write from *another* client — what the panel's WS refresh reacts to. */
async function putSetting(
  base: string,
  key: string,
  value: unknown,
): Promise<void> {
  const response = await fetch(`${base}/api/settings/${key}`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ value }),
  });
  if (!response.ok) {
    throw new Error(
      `PUT /api/settings/${key} failed: ${response.status} ${await response.text()}`,
    );
  }
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

  test("a live change from elsewhere refreshes the list without losing the filter, and an empty number field is refused rather than written as a zero", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const base = requireServer().baseUrl;

    await page.goto(`${base}/`);
    await expect(page.getByTestId("attention-header-count")).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();

    const rows = page.locator('[data-testid^="settings-row-"]');
    await page.getByTestId("settings-search-input").fill("tick");
    await expect(rows).toHaveCount(2);

    // Another client writes a setting, so the panel refreshes off the
    // `setting` WS event. The changed row saying "(overridden)" is the proof
    // that refresh actually happened — and the list is still the two rows the
    // filter matched, rather than the whole catalog re-listed under a filter
    // the subscription had captured before anything was typed.
    const tickRow = page.locator("li", {
      has: page.getByTestId("settings-row-attentionTickSeconds"),
    });
    await putSetting(base, "attentionTickSeconds", 45);
    await expect(tickRow).toContainText("(overridden)");
    await expect(rows).toHaveCount(2);

    // An empty field is not a zero — and this setting is one where a zero is
    // a real, accepted value ("zero disables the schedule"), so nothing
    // downstream would have refused it on the panel's behalf.
    await page.getByTestId("settings-row-attentionTickSeconds").click();
    await page.getByTestId("settings-value-input").fill("");
    await page.getByTestId("settings-save").click();
    await expect(page.getByTestId("settings-error")).toContainText(
      '"attentionTickSeconds" must be a finite number',
    );
    const unchanged = await apiGet<{ setting: { value: unknown } }>(
      base,
      "/api/settings/attentionTickSeconds",
    );
    expect(unchanged.setting.value).toBe(45);

    // Left as it was found: clearing a value is this verb, not an empty save.
    await page.getByTestId("settings-remove-override").click();
    await expect(tickRow).not.toContainText("(overridden)");

    // A save reseeds the field from what the write returned, rather than
    // leaving whatever was typed in it: the server normalises this list, so
    // the field showing the normalised form is that reseed happening. It is
    // the same line that empties the field after writing a *sensitive* value
    // — the case no fixture can exercise here, because configuring the one
    // sensitive setting (`credential`) locks this very page out (§12).
    await page.getByTestId("settings-search-input").fill("Trusted origins");
    await page.getByTestId("settings-row-trustedOrigins").click();
    const originsInput = page.getByTestId("settings-value-input");
    await originsInput.fill(" https://a.example ,, https://b.example ");
    await page.getByTestId("settings-save").click();
    await expect(originsInput).toHaveValue(
      "https://a.example, https://b.example",
    );
    await page.getByTestId("settings-remove-override").click();
    await expect(originsInput).toHaveValue("");
  });

  test("a failed settings read is reported where it can actually be seen", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const base = requireServer().baseUrl;

    await page.goto(`${base}/`);
    await expect(page.getByTestId("attention-header-count")).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(
      page.locator('[data-testid^="settings-row-"]').first(),
    ).toBeVisible();

    // The failure clears the rows, which unselects — so the report has to live
    // outside the detail pane, or it unmounts in the same commit that writes
    // it and the operator is left with an empty catalog and no explanation.
    await page.route("**/api/settings*", (route) => route.abort());
    await page.getByTestId("settings-search-input").fill("tick");
    await expect(page.getByTestId("settings-error")).toBeVisible();
    await expect(page.locator('[data-testid^="settings-row-"]')).toHaveCount(0);

    await page.unroute("**/api/settings*");
    await page.getByTestId("settings-search-input").fill("Attention tick");
    await expect(page.getByTestId("settings-error")).toHaveCount(0);
    await expect(
      page.getByTestId("settings-row-attentionTickSeconds"),
    ).toBeVisible();
  });

  test("a failed search read is reported, never left as the previous query's hits", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const base = requireServer().baseUrl;

    await page.route("**/api/search*", (route) => route.abort());
    await page.goto(`${base}/`);
    await expect(page.getByTestId("attention-header-count")).toBeVisible();
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await page.getByTestId("search-panel-input").fill("anything at all");

    await expect(page.getByTestId("search-panel-error")).toBeVisible();
    await expect(
      page.getByTestId("search-panel-results").getByTestId("search-result"),
    ).toHaveCount(0);
    // Said where a screen reader hears it too, and never as "no results".
    await expect(page.getByTestId("search-panel-live-region")).toContainText(
      "search failed",
    );

    // Not sticky: the next read that answers clears it.
    await page.unroute("**/api/search*");
    await page.getByTestId("search-panel-input").fill("something else again");
    await expect(page.getByTestId("search-panel-error")).toHaveCount(0);
  });

  test("a failed log read is reported, and never renders as an empty filter match", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const base = requireServer().baseUrl;

    await page.route("**/api/logs*", (route) => route.abort());
    await page.goto(`${base}/`);
    await expect(page.getByTestId("attention-header-count")).toBeVisible();
    await page.getByRole("button", { name: "Logs", exact: true }).click();

    await expect(page.getByTestId("logs-error")).toBeVisible();
    // "nothing matches this filter" is a claim about the log, and a read that
    // never answered is in no position to make it.
    await expect(
      page.getByText("no log entries match this filter"),
    ).toHaveCount(0);

    await page.unroute("**/api/logs*");
    await page.getByTestId("logs-refresh").click();
    await expect(page.getByTestId("logs-error")).toHaveCount(0);
  });

  test("logs are queryable and a component filter that matches nothing shows the panel's own honest empty state", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const base = requireServer().baseUrl;

    // The gate's own server runs at "error" (quiet test output); lower it
    // through the same write path another client would use — the setting is
    // live-applying — so an ordinary request actually lands an "info" line in
    // the ring buffer to query.
    await putSetting(base, "logLevel", "info");
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
