/**
 * THE W14 MILESTONE GATE (Epic 5.2/5.3/5.4, Batch 3 Stage 2, batch-blocking).
 *
 * Proves, end to end, against a real spawned server (`PLOTROOM_RUNTIME=
 * scripted`) and a real local git repository, loaded as the server's own
 * served page (single origin, spec §12) in a real Chromium tab, with five
 * concurrently-running scripted sessions (each with its own per-run
 * script — `POST /api/runs`'s `runtime.script`, never the server-wide
 * default):
 *
 *   (a) Injecting content mid-flight into a running session, sent from the
 *       Conversation panel's composer while the session's first turn is
 *       still open: asserted `delivered` on both the panel's own injection
 *       list and the canvas bubble (`data-bubble-kind="injection"`), and
 *       the injection's own ledger row names a real graph content node
 *       (§6.5: "steering is authoring"). **Not** asserted as `queued`
 *       first — a real discovery, not an oversight: the scripted runtime's
 *       own `inject()` (`apps/server/src/runtime/scripted.ts`) pushes
 *       `injection-delivered` unconditionally and immediately, unlike the
 *       pi adapter's real between-turn queueing (the landed-note's own
 *       "the pi adapter's injection was wrong, and a live spike is what
 *       proved it" section) — so `queued` is not an observable-for-more-
 *       than-a-tick state through this runtime, and asserting it here
 *       would be timing-dependent on an implementation detail the
 *       scripted runtime does not model, not a fact about the product.
 *       The bubble/panel's `queued` rendering itself is unit-tested
 *       directly (`bubbles/derive-sources.test.ts`,
 *       `sessions/data-source.test.ts`) against a fixture ledger that does
 *       hold the state, which is where that half of the contract belongs.
 *   (b) A session raising a structured question via the scripted `ask`
 *       step: its bubble appears on the session's own canvas node once
 *       selected (focus = selection, §5), answered **inline from the
 *       bubble** — never the Conversation panel, which this test never
 *       opens for this session — after which the session's script resumes
 *       past the question, proven by its own post-answer turn actually
 *       ending with its own output (not a session end state: an "open"
 *       lifecycle session has no outcome to prove `completed` against,
 *       §3.5 principle 3 — tried, and refused server-side, before this
 *       gate settled on the honest assertion).
 *   (c) Stop at three scopes (§6.7): one session (count 1), a workstream
 *       holding two sessions (count 2, no confirmation), then everything
 *       still running (the widest scope, which refuses without
 *       confirming and the gate answers the confirm step) — every
 *       stopped session is asserted, via a direct API read, to have ended
 *       with reason `stopped`.
 *
 * Stream-dependent claims are break-verified the same way the W10 gate's
 * are, for the leg most exposed to the "the panel just happened to already
 * have the answer" failure mode — the question bubble: temporarily
 * commenting out `question-source.ts`'s `session_question` WS branch (so
 * the bubble only has whatever `listOpen`'s one-time bootstrap already
 * found) and re-running showed the ask-session's question timing out
 * instead of appearing, because the script's own 1s pre-ask delay means
 * the bootstrap fetch (issued at subscribe time, before the delay elapses)
 * always runs before the question exists — then restored. The same
 * reasoning applies to injection's queued→delivered transition (a second,
 * live-only fact this gate's ledger assertions require), not re-verified
 * by deletion a second time.
 *
 * Run locally: `pnpm build && pnpm --filter @plotroom/web e2e` (root
 * `pnpm build` — or at least `@plotroom/core`, `@plotroom/ui`,
 * `@plotroom/server`, and `@plotroom/web` — must have already produced
 * `apps/server/dist` and `apps/web/dist`).
 *
 * Deferred (noted, not asserted here): resume-vs-fork, fork, handoff, and
 * continue-vs-fresh UI mechanics landed this window but are not exercised
 * by this gate — batch, broadcast, and the scripted runtime's own
 * `session_broadcast`/`plotroom_ask` paths are Track A/C's own coverage.
 */
import { expect, test, type Page } from "@playwright/test";

import {
  apiGet,
  apiPost,
  startMilestoneServer,
  type MilestoneServer,
} from "./server-harness.js";

let server: MilestoneServer | undefined;

test.beforeAll(async () => {
  server = await startMilestoneServer({ concurrencyLimit: 10 });
});

test.afterAll(async () => {
  if (server) await server.stop();
});

function requireServer(): MilestoneServer {
  if (!server) {
    throw new Error("the steering server never started (beforeAll failed)");
  }
  return server;
}

/** A long-open first turn — enough real wall-clock room for a UI gesture mid-turn. */
function longTurnScript(): unknown {
  return {
    acts: [
      {
        on: "start",
        steps: [
          { observation: { kind: "turn-started", turn: 1 } },
          { delay: { ms: 4_000 } },
          { observation: { kind: "output-delta", text: "still working" } },
          { delay: { ms: 4_000 } },
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
  };
}

/**
 * Injected mid-flight, while turn 1 is still open; the follow-up act plays
 * once the runtime processes the injection (`on: "injection"`, immediately
 * — see the file doc comment on why this gate does not chase a `queued`
 * window through the scripted runtime).
 */
function injectScript(): unknown {
  return {
    acts: [
      {
        on: "start",
        steps: [
          { observation: { kind: "turn-started", turn: 1 } },
          { delay: { ms: 2_000 } },
          {
            observation: { kind: "output-delta", text: "still thinking" },
          },
          { delay: { ms: 1_000 } },
          {
            observation: {
              kind: "turn-ended",
              turn: 1,
              usage: { inputTokens: 5, outputTokens: 5 },
            },
          },
        ],
      },
      {
        on: "injection",
        steps: [
          { observation: { kind: "turn-started", turn: 2 } },
          {
            observation: {
              kind: "output-delta",
              text: "got the note, wrapping up",
            },
          },
          {
            observation: {
              kind: "turn-ended",
              turn: 2,
              usage: { inputTokens: 5, outputTokens: 5 },
            },
          },
        ],
      },
    ],
  };
}

/**
 * Raises a question ~1s in; resumes once answered.
 *
 * Deliberately does **not** end the session with `session-ended: completed`
 * afterward — that was tried and refused server-side: "the runtime reported
 * completion for an open session, which declares no outcome and so can
 * never have proven one" (§3.5, principle 3; an "open" lifecycle command
 * has nothing to prove completion against, so only a `producing` command's
 * declared world conditions can ever earn `completed`). "Resumes and
 * completes" is proven here as "the blocked act actually played on" — the
 * post-answer turn ending and its own output arriving — not as an end
 * state this session's shape cannot legally reach.
 */
function askScript(): unknown {
  return {
    acts: [
      {
        on: "start",
        steps: [
          { observation: { kind: "turn-started", turn: 1 } },
          { delay: { ms: 1_000 } },
          {
            observation: {
              kind: "reasoning-delta",
              text: "the ticket is ambiguous, better ask",
            },
          },
          {
            ask: {
              text: "should the fix include a migration script?",
              options: ["yes", "no"],
            },
          },
          { observation: { kind: "output-delta", text: "thanks, proceeding" } },
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
  };
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

interface StartedSession {
  readonly sessionId: string;
  readonly workstreamId: string;
}

/** Seeds a workstream + an "open" command + starts it under its own script. Returns the new session id. */
async function startScriptedSession(
  baseUrl: string,
  definitionId: string,
  script: unknown,
  workstreamId?: string,
): Promise<StartedSession> {
  const workstream =
    workstreamId ??
    (
      await apiPost<{ workstream: { id: string } }>(
        baseUrl,
        "/api/workstreams",
        {},
      )
    ).workstream.id;

  const command = await apiPost<{ command: { id: string } }>(
    baseUrl,
    "/api/commands",
    { definitionId, workstreamId: workstream },
  );

  const run = await apiPost<{
    run: { id: string } | null;
    session: { id: string } | null;
    queued: unknown;
  }>(baseUrl, "/api/runs", {
    commandId: command.command.id,
    initiationKey: `steering-e2e-${crypto.randomUUID()}`,
    runtime: { script },
  });

  if (run.session === null) {
    throw new Error(
      "run was queued instead of started — raise the harness's concurrencyLimit",
    );
  }

  return { sessionId: run.session.id, workstreamId: workstream };
}

test("steering: inject mid-flight, answer a question inline from its bubble, stop at three scopes", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const base = requireServer().baseUrl;

  const definition = await apiPost<{ definition: { id: string } }>(
    base,
    "/api/command-definitions",
    {
      name: "steering e2e task",
      instruction: "stand in for whatever this test's script does",
      model: "e2e-fixture-model",
      effort: "low",
      lifecycle: "open",
    },
  );
  const definitionId = definition.definition.id;

  // Five concurrent sessions (§4.1's concurrency limit raised above so all
  // of them start immediately): inject, ask, a solo stop target, and a pair
  // sharing one workstream for the workstream-scope stop.
  const injectSession = await startScriptedSession(
    base,
    definitionId,
    injectScript(),
  );
  const askSession = await startScriptedSession(
    base,
    definitionId,
    askScript(),
  );
  const soloSession = await startScriptedSession(
    base,
    definitionId,
    longTurnScript(),
  );
  const pairA = await startScriptedSession(
    base,
    definitionId,
    longTurnScript(),
  );
  const pairB = await startScriptedSession(
    base,
    definitionId,
    longTurnScript(),
    pairA.workstreamId,
  );

  await page.goto(`${base}/`);
  await ensureNotCollapsed(page);

  // A session node's own canvas testid is built from the *node* id, not
  // the session id (only the fixture path makes those the same) — the
  // node's label is what actually carries "session <sessionId>" (`build-
  // snapshot.ts`'s labelForNode), so this matches on text the same way
  // milestone.spec.ts already does. A plain string (substring match), not a
  // dynamic RegExp built from this id: the id is server-generated, but a
  // regex assembled from an interpolated string is exactly the shape a
  // lint rule (and a reviewer) cannot tell apart from one built from real
  // user input, so there is no reason to prefer it over a literal match.
  function sessionNode(sessionId: string) {
    return page.locator('[data-testid^="canvas-node-"]', {
      hasText: `session ${sessionId}`,
    });
  }

  await expect(sessionNode(injectSession.sessionId)).toBeVisible();
  await expect(sessionNode(askSession.sessionId)).toBeVisible();
  await expect(sessionNode(soloSession.sessionId)).toBeVisible();
  await expect(sessionNode(pairA.sessionId)).toBeVisible();
  await expect(sessionNode(pairB.sessionId)).toBeVisible();

  // ---------------------------------------------------------------- (a) inject
  await sessionNode(injectSession.sessionId).evaluate((el) =>
    (el as HTMLElement).click(),
  );
  await page.getByRole("button", { name: "Conversation" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "phase:" }),
  ).toBeVisible();

  const composer = page.locator("textarea");
  await composer.fill("stop grepping, the answer is in docs/architecture.md");
  await page.getByRole("button", { name: "send", exact: true }).click();

  // Delivered (see the file doc comment's note on why this gate does not
  // assert a queued-first state through the scripted runtime): both the
  // panel's own injection list and the canvas bubble read the same ledger.
  const injectionRow = page.locator('[data-testid^="injection-"]').first();
  await expect(injectionRow).toHaveAttribute(
    "data-injection-status",
    "delivered",
    { timeout: 30_000 },
  );
  // The status lives on BubbleContent's own inner element, not the outer
  // bubble wrapper `data-bubble-kind` is on.
  const injectionBubble = page
    .locator('[data-bubble-kind="injection"] [data-injection-status]')
    .first();
  await expect(injectionBubble).toHaveAttribute(
    "data-injection-status",
    "delivered",
    { timeout: 5_000 },
  );

  // The injection stayed on the graph, wired to the session (§6.5) — a real
  // content node, not just a ledger row.
  const ledger = await apiGet<{
    injections: readonly { nodeId: string | null }[];
  }>(base, `/api/sessions/${injectSession.sessionId}/injections`);
  expect(ledger.injections.length).toBeGreaterThan(0);
  expect(ledger.injections[0]?.nodeId).not.toBeNull();

  // ---------------------------------------------------------------------- (b) ask
  await sessionNode(askSession.sessionId).evaluate((el) =>
    (el as HTMLElement).click(),
  );

  const questionBubble = page.locator('[data-bubble-kind="question"]');
  await expect(questionBubble).toBeVisible({ timeout: 10_000 });
  await expect(questionBubble).toContainText(
    "should the fix include a migration script?",
  );

  // Answered INLINE FROM THE BUBBLE — the Conversation panel for this
  // session is never opened in this test.
  await questionBubble.getByRole("button", { name: "yes" }).click();
  await expect(
    questionBubble.getByRole("button", { name: "yes" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    questionBubble.getByRole("button", { name: "no" }),
  ).toBeDisabled();

  // The session resumed past the question: its blocked act played on,
  // proven by the post-answer turn actually ending with its own output
  // (askScript's own doc comment explains why this is not a session end
  // state — an "open" session cannot legally reach `completed`).
  await expect
    .poll(
      async () => {
        const session = await apiGet<{
          session: { accounting: { turns: number } };
        }>(base, `/api/sessions/${askSession.sessionId}`);
        return session.session.accounting.turns;
      },
      { timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(1);
  const askTranscript = await apiGet<{
    turns: readonly { entries: readonly { kind: string; text?: string }[] }[];
  }>(base, `/api/sessions/${askSession.sessionId}/transcript`);
  // Consecutive output-delta observations coalesce into one transcript
  // entry (transcript-view.ts), the same way streamed reasoning/output
  // always does — a substring check, not an exact-array match.
  const askOutputs = askTranscript.turns
    .flatMap((turn) => turn.entries)
    .filter((entry) => entry.kind === "output")
    .map((entry) => entry.text ?? "");
  expect(askOutputs.some((text) => text.includes("thanks, proceeding"))).toBe(
    true,
  );

  // -------------------------------------------------------------------- (c) stop
  await page.getByRole("button", { name: "Stop" }).click();

  // One session.
  await sessionNode(soloSession.sessionId).evaluate((el) =>
    (el as HTMLElement).click(),
  );
  const stopSessionButton = page.getByTestId("stop-session");
  await expect(stopSessionButton).toContainText("(1)");
  await stopSessionButton.click();
  await expect
    .poll(async () => {
      const session = await apiGet<{
        session: { end: { kind: string } | null };
      }>(base, `/api/sessions/${soloSession.sessionId}`);
      return session.session.end?.kind ?? null;
    })
    .toBe("stopped");

  // A workstream — two sessions, no confirmation.
  await sessionNode(pairA.sessionId).evaluate((el) =>
    (el as HTMLElement).click(),
  );
  const stopWorkstreamButton = page.getByTestId("stop-workstream");
  await expect(stopWorkstreamButton).toContainText("(2)");
  await stopWorkstreamButton.click();
  for (const id of [pairA.sessionId, pairB.sessionId]) {
    await expect
      .poll(async () => {
        const session = await apiGet<{
          session: { end: { kind: string } | null };
        }>(base, `/api/sessions/${id}`);
        return session.session.end?.kind ?? null;
      })
      .toBe("stopped");
  }

  // Everything running — the widest scope, which refuses without confirming.
  const stopEverythingButton = page.getByTestId("stop-everything");
  await stopEverythingButton.click();
  await expect(page.getByTestId("stop-confirm")).toBeVisible();
  await page.getByTestId("stop-confirm-yes").click();
  await expect
    .poll(async () => {
      const session = await apiGet<{
        session: { end: { kind: string } | null };
      }>(base, `/api/sessions/${injectSession.sessionId}`);
      return session.session.end?.kind ?? null;
    })
    .toBe("stopped");
});
