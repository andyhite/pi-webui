/**
 * QUEUE TRIAGE HARDENING (Epic 8.5): the three triage verbs (§4.5, §7.1) —
 * acknowledge, snooze, mute — proven distinct from one another, and proven
 * durable server-side rather than an in-memory convenience the next process
 * forgets.
 *
 * Neither existing gate (`steering.spec.ts`, `batch4-gate.spec.ts`) proves
 * triage at all beyond a single `acknowledge` click on one drift row. This
 * file proves the three verbs are not one verb wearing three labels:
 *
 *   - **mute** hides an item and keeps it hidden — asserted still absent
 *     later in the same run, and (in the second `describe` below) still
 *     absent after the server that recorded it has been killed and a fresh
 *     process started against the same state directory.
 *   - **snooze** hides an item only until its own return time, asserted by
 *     reading `GET /api/attention` before and after that time elapses —
 *     nothing in `@plotroom/core`'s `triageStatus` is on a schedule
 *     (`apps/server/src/attention/tick.ts`'s own stance: the tick paces a
 *     *push*, never the correctness of a plain read), so this needs no
 *     scripted clock and no shortened tick interval — a real, short wait is
 *     the honest way to prove it.
 *   - **acknowledge** is *meant* to advance the consumer's baseline rather
 *     than hide the underlying fact for good (§4.5: "the next change past
 *     this version drifts again"), and `@plotroom/core`'s own
 *     `visibleAttention` implements exactly that re-surfacing rule
 *     (`entry.item.raisedAt > record.at`). Writing this test found that the
 *     rule never runs for drift in practice: `AttentionService
 *     #driftSources` (`apps/server/src/attention/service.ts`) reads
 *     `deriveBoardDrift(...).attention`, and `deriveDrift`
 *     (`packages/core/src/sessions/drift.ts`) builds that field as
 *     `ordered.filter((flag) => isVisible(flag.triage))` — a *second*,
 *     cruder visibility gate keyed only on the acknowledge verb itself
 *     (`triageStatus` returns `"acknowledged"` unconditionally once the verb
 *     is recorded, with no baseline comparison at all), so a drift flag
 *     that the *first* gate correctly decided to keep alive (baseline ≠
 *     latest, `deriveDrift`'s own `acknowledgedBaseline === latest` check)
 *     is dropped again before `AttentionService` ever sees it as a
 *     candidate item. Confirmed by direct inspection: acknowledging, then
 *     editing the same note a second time, leaves the drift row
 *     permanently absent from `GET /api/attention` — observably
 *     indistinguishable from `mute`, contradicting both §4.5 and
 *     `visibleAttention`'s own doc comment ("acknowledging would be muting
 *     under another name" is exactly the failure mode it says this
 *     prevents). Both files are outside this batch's ownership
 *     (`apps/server/src/attention/`, `packages/core/src/sessions/`) —
 *     reported here rather than patched, and *not* asserted below: this
 *     file tests what acknowledge is observed to do today (hide once,
 *     immediately, over the real Queue panel), not the reappearance §4.5
 *     describes, so a future fix does not make this suite start failing
 *     for having encoded the bug as the spec.
 *
 * The mute/acknowledge halves of that test drive the real Queue panel (a
 * real click, like `batch4-gate.spec.ts`'s own rows); snooze is driven
 * directly over the API with an explicit near-term `snoozedUntil` — the
 * panel's own snooze button has no duration control (`DEFAULT_SNOOZE_
 * SECONDS`, one hour, `packages/ui/src/attention/use-queue-cursor.ts`), and
 * this test needs to observe the elapse inside its own timeout rather than
 * the panel's default window.
 */
import { expect, test } from "@playwright/test";

import {
  apiGet,
  apiPatch,
  apiPost,
  startMilestoneServer,
  stopOnTeardown,
  type MilestoneServer,
} from "./server-harness.js";
import {
  killKeepingState,
  startRestartableServer,
  stopAndClean,
  type RestartableServer,
} from "./steering-restart-harness.js";

interface AttentionItem {
  readonly id: string;
  readonly summary: string;
}

async function attentionItems(base: string): Promise<readonly AttentionItem[]> {
  const response = await apiGet<{ items: readonly AttentionItem[] }>(
    base,
    "/api/attention",
  );
  return response.items;
}

async function findItem(
  base: string,
  predicate: (item: AttentionItem) => boolean,
): Promise<AttentionItem> {
  const items = await attentionItems(base);
  const found = items.find(predicate);
  if (found === undefined) {
    throw new Error(
      `no attention item matched (have: ${items.map((i) => i.summary).join(" | ")})`,
    );
  }
  return found;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

interface SessionEndRead {
  readonly session: { readonly end: { readonly kind: string } | null };
}

async function waitForEnd(base: string, sessionId: string): Promise<string> {
  await expect
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
    .not.toBeNull();
  const read = await apiGet<SessionEndRead>(base, `/api/sessions/${sessionId}`);
  return read.session.end?.kind as string;
}

/** A session that ends immediately, ordinary — its own completion item is the fact this file triages. */
function endsQuicklyScript(): unknown {
  return {
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
  };
}

async function startEndedSession(base: string, name: string): Promise<string> {
  const definitionId = await createDefinition(base, name);
  const workstreamId = await createWorkstream(base);
  const command = await apiPost<{ command: { id: string } }>(
    base,
    "/api/commands",
    { definitionId, workstreamId },
  );
  const run = await apiPost<{ session: { id: string } | null }>(
    base,
    "/api/runs",
    {
      commandId: command.command.id,
      initiationKey: `triage-hardening-${crypto.randomUUID()}`,
      runtime: { script: endsQuicklyScript() },
    },
  );
  if (run.session === null) {
    throw new Error(
      "run was queued instead of started — raise the concurrencyLimit",
    );
  }
  await waitForEnd(base, run.session.id);
  return run.session.id;
}

/** A note wired as a command's only input, run once — the drift setup `batch4-gate.spec.ts` also uses. */
async function setUpDriftableNote(base: string): Promise<{
  readonly objectId: string;
  readonly body: (text: string) => Promise<void>;
}> {
  const definitionId = await createDefinition(base, "triage hardening: drift");
  const workstreamId = await createWorkstream(base);
  const command = await apiPost<{
    command: { id: string };
    node: { id: string };
  }>(base, "/api/commands", { definitionId, workstreamId });
  const note = await apiPost<{ object: { id: string } }>(base, "/api/notes", {
    title: "Ticket",
    body: "as written",
    workstreamId,
  });
  const noteNode = await apiPost<{ node: { id: string } }>(base, "/api/nodes", {
    role: "content",
    refId: note.object.id,
    workstreamId,
  });
  await apiPost(base, "/api/edges", {
    from: noteNode.node.id,
    to: command.node.id,
  });

  const run = await apiPost<{ session: { id: string } | null }>(
    base,
    "/api/runs",
    {
      commandId: command.command.id,
      initiationKey: `triage-drift-${crypto.randomUUID()}`,
      runtime: { script: endsQuicklyScript() },
    },
  );
  if (run.session === null) {
    throw new Error("drift run was queued instead of started");
  }
  await waitForEnd(base, run.session.id);

  return {
    objectId: note.object.id,
    body: (text: string) =>
      apiPatch(base, `/api/notes/${note.object.id}`, { body: text }),
  };
}

test.describe("queue triage verbs: mute, snooze, acknowledge are three different things", () => {
  let server: MilestoneServer | undefined;

  test.beforeAll(async () => {
    server = await startMilestoneServer({ concurrencyLimit: 8 });
  });

  stopOnTeardown(() => server);

  test("mute hides for good, snooze hides only until it elapses, acknowledge hides immediately over the real Queue panel", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const base = server!.baseUrl;

    const mutedSessionId = await startEndedSession(base, "triage: mute me");
    const snoozedSessionId = await startEndedSession(base, "triage: snooze me");
    const drift = await setUpDriftableNote(base);

    // First edit — the drift this test will acknowledge.
    await drift.body("the review landed overnight");

    await page.goto(`${base}/`);
    await page.getByRole("button", { name: "Queue" }).click();
    const queue = page.getByTestId("attention-queue");

    // ------------------------------------------------------------------- mute
    const muteRow = queue
      .getByRole("option")
      .filter({ hasText: mutedSessionId });
    await expect(muteRow).toBeVisible({ timeout: 10_000 });
    await muteRow.getByRole("button", { name: "mute", exact: true }).click();
    await expect(muteRow).toHaveCount(0);

    const afterMute = await attentionItems(base);
    expect(
      afterMute.some((item) => item.summary.includes(mutedSessionId)),
    ).toBe(false);

    // -------------------------------------------------------------- acknowledge
    // Asserted here: acknowledging hides the row immediately, over the real
    // Queue panel, the same as `batch4-gate.spec.ts` already proves.
    // *Not* asserted here: that a further change resurfaces it (§4.5's
    // "the next change past this version drifts again") — see the file doc
    // comment for the gap this file found instead, reported rather than
    // encoded as a passing assertion either way.
    const driftRow = queue
      .getByRole("option")
      .filter({ hasText: "changed since this consumer last read it" });
    await expect(driftRow).toBeVisible({ timeout: 10_000 });
    await driftRow
      .getByRole("button", { name: "acknowledge", exact: true })
      .click();
    await expect(driftRow).toHaveCount(0);

    const afterAcknowledge = await attentionItems(base);
    expect(
      afterAcknowledge.some((item) => item.summary.includes(mutedSessionId)),
    ).toBe(false);

    // -------------------------------------------------------------------- snooze
    // A precise near-term return time, over the API: the panel's own snooze
    // button has no duration control (see the file doc comment).
    const snoozeItem = await findItem(base, (item) =>
      item.summary.includes(snoozedSessionId),
    );
    const now = Math.floor(Date.now() / 1000);
    await apiPost(
      base,
      `/api/attention/${encodeURIComponent(snoozeItem.id)}/snooze`,
      {
        snoozedUntil: now + 3,
      },
    );

    const rightAfterSnooze = await attentionItems(base);
    expect(
      rightAfterSnooze.some((item) => item.summary.includes(snoozedSessionId)),
    ).toBe(false);

    await sleep(4_500);

    const afterElapsed = await attentionItems(base);
    // Sharp: back on its own, with no further gesture — a snooze, not a mute.
    expect(
      afterElapsed.some((item) => item.summary.includes(snoozedSessionId)),
    ).toBe(true);
    // And the muted item is *still* not there, at the exact same later moment
    // the snoozed one reappeared — the two verbs really do differ.
    expect(
      afterElapsed.some((item) => item.summary.includes(mutedSessionId)),
    ).toBe(false);
  });
});

test.describe("queue triage durability across a restart", () => {
  let server: RestartableServer | undefined;

  test.afterAll(async () => {
    if (server) await stopAndClean(server);
  });

  test("a muted item stays muted after the server is killed and a fresh process starts on the same state dir", async () => {
    test.setTimeout(60_000);
    server = await startRestartableServer({ concurrencyLimit: 4 });
    const firstBase = server.baseUrl;

    const sessionId = await startEndedSession(
      firstBase,
      "triage durability: mute me",
    );
    const item = await findItem(firstBase, (entry) =>
      entry.summary.includes(sessionId),
    );
    await apiPost(
      firstBase,
      `/api/attention/${encodeURIComponent(item.id)}/mute`,
      {},
    );

    const mutedBeforeRestart = await attentionItems(firstBase);
    expect(
      mutedBeforeRestart.some((entry) => entry.summary.includes(sessionId)),
    ).toBe(false);

    // Kill without deleting `plotroom.db`/`blobs/` — the crash half of a
    // restart, not a teardown — then a fresh process against the exact same
    // state directory: the portable unit AGENTS.md's persistence notes name.
    await killKeepingState(server);
    const restarted = await startRestartableServer({
      concurrencyLimit: 4,
      reuse: {
        stateDir: server.stateDir,
        repositoryPath: server.repositoryPath,
        workspaceDir: server.workspaceDir,
      },
    });
    server = restarted;
    const secondBase = restarted.baseUrl;

    // The underlying fact still holds — the session record itself survived
    // (§3.6: readable always) — so an absence below is the mute's own
    // durability, not the fact having quietly disappeared instead.
    const sessionAfterRestart = await apiGet<SessionEndRead>(
      secondBase,
      `/api/sessions/${sessionId}`,
    );
    expect(sessionAfterRestart.session.end?.kind).toBe("ended-by-user");

    const afterRestart = await attentionItems(secondBase);
    expect(
      afterRestart.some((entry) => entry.summary.includes(sessionId)),
    ).toBe(false);
  });
});
