/**
 * THE BATCH 4 GATE (Epic 6.1/6.2, Stage 2, batch-blocking).
 *
 * Proves, end to end, against a real spawned server (`PLOTROOM_RUNTIME=
 * scripted`) and a real local git repository, loaded as the server's own
 * served page (single origin, spec §12) in a real Chromium tab, over the
 * live attention wiring this stage landed (`GET /api/attention` + the
 * `attention` `/ws` entity):
 *
 *   (a) **Budgets bind transitively, live.** A parent session's own run
 *       carries a spend cap; a child session, started as a *delegation*
 *       (`POST /api/runs` with a session actor, §3.6) from the parent, into
 *       a *different* workstream with no cap of its own, accrues enough
 *       scripted cost that the combined chain total — parent's own spend
 *       plus the child's, attributed up the chain before the cap is
 *       checked (`RunService#enforceBudget`) — crosses the parent's run
 *       cap. The **child** is what PlotRoom stops, out-of-budget: proof
 *       that a cap bound to an ancestor's run counts a descendant's spend,
 *       not just its own. Asserted as its own distinct end state — never
 *       `failed` — on the session's own card (`ConversationPanel`'s
 *       `session-end` text) and worded in the queue's completions feed
 *       (§7.1, §8).
 *   (b) **The queue answers without opening anything.** A question
 *       (scripted `ask`), an approval (scripted `call` — an undeclared
 *       tool, which blocks the session until answered, §6.6), and a drift
 *       item (a note a run consumed, edited afterward — §4.5) all appear
 *       as rows in the Queue panel. Each is answered **in its own row**:
 *       the question by its option, the approval by "Approve once" (after
 *       which the blocked call actually proceeds, script and all, to the
 *       session's own end), the drift by acknowledging it. The
 *       Conversation panel is never opened for any of the three sessions
 *       involved — asserted explicitly, not just implied by never clicking
 *       it.
 *
 * The drift row is the stream-dependent leg: the note is edited only
 * *after* the page has already subscribed to `/ws`, so the row the test
 * waits for and acts on can only have arrived over the live `attention`
 * event, never the initial `GET /api/attention` snapshot the subscription
 * resyncs from at connect time. Break-verified by temporarily disabling
 * `createApiAttentionDataSource`'s live-event branch
 * (`packages/ui/src/attention/data-source.ts`) and re-running: the drift
 * row never appeared and the test failed on it, exactly as claimed; the
 * code was restored byte-identical afterward (see the batch report).
 *
 * Run locally: `pnpm build && pnpm --filter @plotroom/web e2e` (root
 * `pnpm build` — or at least `@plotroom/core`, `@plotroom/ui`,
 * `@plotroom/server`, and `@plotroom/web` — must have already produced
 * `apps/server/dist` and `apps/web/dist`).
 */
import { expect, test, type Page } from "@playwright/test";

import {
  apiGet,
  apiPatch,
  apiPost,
  startMilestoneServer,
  type MilestoneServer,
} from "./server-harness.js";

let server: MilestoneServer | undefined;

test.beforeAll(async () => {
  server = await startMilestoneServer({ concurrencyLimit: 8 });
});

test.afterAll(async () => {
  if (server) await server.stop();
});

function requireServer(): MilestoneServer {
  if (!server) {
    throw new Error("the batch 4 server never started (beforeAll failed)");
  }
  return server;
}

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

async function createWorkstream(base: string): Promise<string> {
  const workstream = await apiPost<{ workstream: { id: string } }>(
    base,
    "/api/workstreams",
    {},
  );
  return workstream.workstream.id;
}

async function instantiateCommand(
  base: string,
  definitionId: string,
  workstreamId: string,
): Promise<{ readonly commandId: string; readonly nodeId: string }> {
  const command = await apiPost<{
    command: { id: string };
    node: { id: string };
  }>(base, "/api/commands", { definitionId, workstreamId });
  return { commandId: command.command.id, nodeId: command.node.id };
}

interface SessionEndRead {
  readonly session: { readonly end: { readonly kind: string } | null };
}

async function waitForEnd(base: string, sessionId: string): Promise<string> {
  return expect
    .poll(
      async () => {
        const read = await apiGet<SessionEndRead>(
          base,
          `/api/sessions/${sessionId}`,
        );
        return read.session.end?.kind ?? null;
      },
      { timeout: 20_000 },
    )
    .not.toBeNull()
    .then(async () => {
      const read = await apiGet<SessionEndRead>(
        base,
        `/api/sessions/${sessionId}`,
      );
      return read.session.end?.kind as string;
    });
}

test.describe("the batch 4 gate", () => {
  test("budgets bind transitively, live: a delegated child is stopped out-of-budget by its parent's run cap", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const base = requireServer().baseUrl;

    // The parent: its own run carries the cap the chain must respect.
    // 12_000 micros ($0.012) — enough room for the parent's own 8_000, not
    // enough once the child's own 8_000 is attributed up to it too.
    const parentDefinitionId = await createDefinition(base, "budget parent");
    const parentWorkstreamId = await createWorkstream(base);
    const parentCommand = await instantiateCommand(
      base,
      parentDefinitionId,
      parentWorkstreamId,
    );

    const parentRun = await apiPost<{
      run: { id: string } | null;
      session: { id: string } | null;
    }>(base, "/api/runs", {
      commandId: parentCommand.commandId,
      initiationKey: `budget-parent-${crypto.randomUUID()}`,
      spendCapMicros: 12_000,
      runtime: {
        script: {
          acts: [
            {
              on: "start",
              steps: [
                { observation: { kind: "turn-started", turn: 1 } },
                { observation: { kind: "output-delta", text: "working" } },
                {
                  observation: {
                    kind: "turn-ended",
                    turn: 1,
                    usage: {
                      inputTokens: 10,
                      outputTokens: 5,
                      costUsd: 0.008,
                    },
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
    });
    if (parentRun.session === null) {
      throw new Error(
        "the parent run was queued instead of started — raise the harness's concurrencyLimit",
      );
    }
    const parentSessionId = parentRun.session.id;

    // The parent ends on its own, well under its own cap: 8_000 of 12_000.
    expect(await waitForEnd(base, parentSessionId)).toBe("ended-by-user");

    // The child: a *different* workstream, no cap of its own, started as a
    // delegation — the actor header is the whole of what makes this a
    // delegation (§3.6), same as `delegation.integration.test.ts` proves
    // server-side; this is the same fact proven through the real HTTP path
    // and the real UI.
    const childDefinitionId = await createDefinition(base, "budget child");
    const childWorkstreamId = await createWorkstream(base);
    const childCommand = await instantiateCommand(
      base,
      childDefinitionId,
      childWorkstreamId,
    );

    const childRun = await apiPost<{
      run: { id: string } | null;
      session: { id: string } | null;
    }>(
      base,
      "/api/runs",
      {
        commandId: childCommand.commandId,
        initiationKey: `budget-child-${crypto.randomUUID()}`,
        runtime: {
          script: {
            acts: [
              {
                on: "start",
                steps: [
                  { observation: { kind: "turn-started", turn: 1 } },
                  { observation: { kind: "output-delta", text: "working" } },
                  {
                    observation: {
                      kind: "turn-ended",
                      turn: 1,
                      usage: {
                        inputTokens: 10,
                        outputTokens: 5,
                        costUsd: 0.008,
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
      { "x-plotroom-actor": `session:${parentSessionId}` },
    );
    if (childRun.session === null) {
      throw new Error(
        "the child run was queued instead of started — raise the harness's concurrencyLimit",
      );
    }
    const childSessionId = childRun.session.id;

    // The child's own spend (8_000) is under any cap of its own — it has
    // none — but combined with the parent's already-spent 8_000, the total
    // attributed to the parent's run (16_000) crosses its 12_000 cap. The
    // CHILD is what stops: PlotRoom's enforcement runs on the session whose
    // accounting just changed (principle 8, `RunService#enforceBudget`).
    expect(await waitForEnd(base, childSessionId)).toBe("out-of-budget");

    await page.goto(`${base}/`);
    await ensureNotCollapsed(page);

    // The queue's completions feed first, before selecting anything — a
    // node's own speech bubble expands once it is focused/selected (§5:
    // "collapse to a count when a node is unfocused"), and can then overlap
    // the dock rail depending on where the canvas panned during the zoom-out
    // above; checking the queue before ever selecting a node sidesteps that
    // incidental overlap entirely rather than fighting it with a forced click.
    await page.getByRole("button", { name: "Queue" }).click();
    const completionRow = page
      .getByTestId("attention-queue")
      .getByRole("option")
      .filter({ hasText: childSessionId });
    await expect(completionRow).toBeVisible();
    await expect(completionRow).toContainText(
      "stopped because it reached a spend cap",
    );

    // The distinct end state, rendered on the session's own card — never
    // "failed" (§3.6, §8).
    const childNode = page.locator('[data-testid^="canvas-node-"]', {
      hasText: `session ${childSessionId}`,
    });
    await expect(childNode).toBeVisible();
    await childNode.evaluate((el) => (el as HTMLElement).click());
    await page.getByRole("button", { name: "Conversation" }).click();

    const sessionEnd = page.getByTestId("session-end");
    await expect(sessionEnd).toContainText("out-of-budget");
    await expect(sessionEnd).not.toContainText("failed");
  });

  test("the queue answers without opening anything: a question, an approval, and drift, each answered in its own row", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const base = requireServer().baseUrl;

    // ------------------------------------------------------------- question
    const questionDefinitionId = await createDefinition(base, "queue question");
    const questionWorkstreamId = await createWorkstream(base);
    const questionCommand = await instantiateCommand(
      base,
      questionDefinitionId,
      questionWorkstreamId,
    );
    const questionRunResult = await apiPost<{
      session: { id: string } | null;
    }>(base, "/api/runs", {
      commandId: questionCommand.commandId,
      initiationKey: `queue-question-${crypto.randomUUID()}`,
      runtime: {
        script: {
          acts: [
            {
              on: "start",
              steps: [
                { observation: { kind: "turn-started", turn: 1 } },
                {
                  ask: {
                    text: "should this ship today?",
                    options: ["yes", "no"],
                  },
                },
                {
                  observation: {
                    kind: "output-delta",
                    text: "thanks, shipping",
                  },
                },
                {
                  observation: {
                    kind: "turn-ended",
                    turn: 1,
                    usage: { inputTokens: 5, outputTokens: 5 },
                  },
                },
              ],
            },
          ],
        },
      },
    });
    if (questionRunResult.session === null) {
      throw new Error("question session was queued, not started");
    }
    const questionSessionId = questionRunResult.session.id;

    // ------------------------------------------------------------- approval
    const approvalDefinitionId = await createDefinition(base, "queue approval");
    const approvalWorkstreamId = await createWorkstream(base);
    const approvalCommand = await instantiateCommand(
      base,
      approvalDefinitionId,
      approvalWorkstreamId,
    );
    const approvalRunResult = await apiPost<{
      session: { id: string } | null;
    }>(base, "/api/runs", {
      commandId: approvalCommand.commandId,
      initiationKey: `queue-approval-${crypto.randomUUID()}`,
      runtime: {
        script: {
          acts: [
            {
              on: "start",
              steps: [
                { observation: { kind: "turn-started", turn: 1 } },
                {
                  call: {
                    toolName: "send_invoice",
                    input: { amount: 42 },
                  },
                },
                {
                  observation: {
                    kind: "output-delta",
                    text: "invoice sent",
                  },
                },
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
    });
    if (approvalRunResult.session === null) {
      throw new Error("approval session was queued, not started");
    }
    const approvalSessionId = approvalRunResult.session.id;

    // ---------------------------------------------------------------- drift
    // A note wired as a command's only context, run once so the run records
    // what version it consumed, then edited *after* the page has already
    // subscribed to /ws — the drift row this test waits for can only ever
    // have arrived over the live `attention` event (see the file doc
    // comment's break-verification note).
    const driftDefinitionId = await createDefinition(base, "queue drift");
    const driftWorkstreamId = await createWorkstream(base);
    const driftCommand = await instantiateCommand(
      base,
      driftDefinitionId,
      driftWorkstreamId,
    );
    const note = await apiPost<{ object: { id: string } }>(base, "/api/notes", {
      title: "Ticket",
      body: "as written",
      workstreamId: driftWorkstreamId,
    });
    const noteNode = await apiPost<{ node: { id: string } }>(
      base,
      "/api/nodes",
      {
        role: "content",
        refId: note.object.id,
        workstreamId: driftWorkstreamId,
      },
    );
    await apiPost(base, "/api/edges", {
      from: noteNode.node.id,
      to: driftCommand.nodeId,
    });
    const driftRunResult = await apiPost<{
      session: { id: string } | null;
    }>(base, "/api/runs", {
      commandId: driftCommand.commandId,
      initiationKey: `queue-drift-${crypto.randomUUID()}`,
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
    });
    if (driftRunResult.session === null) {
      throw new Error("drift session was queued, not started");
    }
    await waitForEnd(base, driftRunResult.session.id);

    // ------------------------------------------------------------------ page
    await page.goto(`${base}/`);
    await ensureNotCollapsed(page);

    // Never opened for any of the three sessions this test answers from the
    // queue — checked explicitly, not just implied by never clicking it.
    const conversationRegion = page.getByRole("region", {
      name: "Conversation",
    });
    await expect(conversationRegion).toHaveCount(0);

    await page.getByRole("button", { name: "Queue" }).click();
    const queue = page.getByTestId("attention-queue");

    // ---------------------------------------------------------- (1) question
    const questionRow = queue
      .getByRole("option")
      .filter({ hasText: "should this ship today?" });
    await expect(questionRow).toBeVisible({ timeout: 10_000 });
    await questionRow.getByRole("button", { name: "yes", exact: true }).click();
    await expect(questionRow).toHaveCount(0);

    // ----------------------------------------------------------- (2) approval
    const approvalRow = queue
      .getByRole("option")
      .filter({ hasText: "send_invoice" });
    await expect(approvalRow).toBeVisible({ timeout: 10_000 });
    await approvalRow.getByRole("button", { name: "Approve once" }).click();
    await expect(approvalRow).toHaveCount(0);

    // The blocked call actually proceeded: the session's own script played
    // on past it, all the way to its own end.
    expect(await waitForEnd(base, approvalSessionId)).toBe("ended-by-user");

    // -------------------------------------------------------------- (3) drift
    // Edited only now — after the page's own /ws subscription is already
    // live — so the row below can only have arrived over a live `attention`
    // event, never the initial snapshot fetch.
    await apiPatch(base, `/api/notes/${note.object.id}`, {
      body: "the review landed overnight",
    });

    const driftRow = queue
      .getByRole("option")
      .filter({ hasText: "changed since this consumer last read it" });
    await expect(driftRow).toBeVisible({ timeout: 10_000 });
    await driftRow.getByRole("button", { name: "acknowledge" }).click();
    await expect(driftRow).toHaveCount(0);

    // Still never opened.
    await expect(conversationRegion).toHaveCount(0);

    // Sanity: the question session did resume past its question (proof the
    // in-row answer was the real answer, not a UI-only optimistic remove).
    const questionSession = await apiGet<{
      session: { accounting: { turns: number } };
    }>(base, `/api/sessions/${questionSessionId}`);
    expect(questionSession.session.accounting.turns).toBeGreaterThanOrEqual(1);
  });
});
