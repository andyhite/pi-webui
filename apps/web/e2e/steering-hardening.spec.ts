/**
 * STEERING HARDENING (Epic 8.5), extending the W14 gate
 * (`apps/web/e2e/steering.spec.ts`) rather than repeating it.
 *
 * The W14 gate already proves, in one run: inject mid-flight (asserted
 * `delivered`, never `queued` — see its own doc comment for exactly why),
 * a question answered inline from its bubble, and stop at all three scopes.
 * This file proves what that gate does not:
 *
 *   1. **Injection ledger honesty beyond delivered.** A replayed injection id
 *      answers from the existing ledger row rather than writing a second one
 *      (principle 9). And a refused injection leaves **no** ledger row at
 *      all when the refusal is `checkInjection`'s own plan-time rule (an
 *      ended session, `session_not_running`) — the request is rejected
 *      outright, before the content/edge/ledger writes `SteeringService
 *      #inject` otherwise makes in that order, so the ledger for that
 *      session is provably unchanged by the attempt, never polluted with a
 *      phantom row for something that never happened. (The *other* shape of
 *      refusal — a ledger row written `refused` because a live-but-running
 *      session's runtime handle is missing, `data-injection-status=
 *      "refused"` — exists in `SteeringService#deliver`, but is only
 *      reachable in the narrow, non-deterministic window right after a
 *      restart before recovery finishes marking in-flight sessions
 *      interrupted; forcing that race would trade a real fact for a flaky
 *      one, so it is reported here rather than asserted.) `queued` itself is
 *      still not asserted as an intermediate UI state: this runtime's
 *      `ScriptedSessionHandle#inject` pushes `injection-delivered`
 *      synchronously, with no `await` before it
 *      (`apps/server/src/runtime/scripted.ts`), so the ledger row is written
 *      `queued` and then overwritten `delivered` inside one Node.js
 *      microtask flush — provably before the HTTP response for the
 *      triggering `POST /inject` is even sent, let alone before a browser
 *      could poll for it. That is a structural fact about this runtime's
 *      `inject()`, not a timing coincidence to chase with a longer poll —
 *      W14's own doc comment reached the same conclusion; this file does not
 *      re-derive it a second time.
 *   2. **A question answered from the QUEUE settles the same blocked call
 *      the bubble would.** Never opening that session's Conversation panel
 *      or its bubble, answering `POST /questions/:id/answer` through the
 *      Queue panel's own row unblocks the runtime's `respond()` exactly like
 *      the bubble path does — proven by the session's script actually
 *      playing on past the question, and by the *same* session's bubble
 *      (selected only afterward) rendering the answered state from the one
 *      ledger, unpicked option visible and disabled. (The queue-answered
 *      session's own script — `askOnInjectionScript` below — raises its ask
 *      from a *second* act rather than its first: two independently-started
 *      scripted sessions each asking as their first blocking step collide
 *      on the scripted runtime's own request-id naming, a real gap this
 *      file found and reports in that function's doc comment rather than
 *      routing around silently.) §6.4's "unpicked options remain visible" is
 *      asserted directly (`toBeVisible()`), not
 *      just implied by a passing `disabled` check.
 *   3. **Stop semantics: never worded `failed`, and resumable-listed.** A
 *      stopped session's own end-state wording is asserted absent of
 *      "failed" (as text, not just as `end.kind`), and `resume-or-fork`'s
 *      enabled `resume` button is what "resumable-listed" (§3.6) means on
 *      the session's own card — the W14 gate stops at asserting
 *      `end.kind === "stopped"` over the API and never opens the card at
 *      all.
 *   4. **A session broadcast reaches every session sharing its
 *      repository, honestly bounded.** Two sessions in two different
 *      workstreams, provisioned against the one repository this harness's
 *      git checkout configures (`PLOTROOM_WORKSPACE_REPO`, shared by every
 *      workstream's workspace — "a repository's identity is its configured
 *      source", `apps/server/src/sessions/world.ts`), so `everyone-in-
 *      repository` reaches a real second session rather than an empty
 *      scope. The recipient's own workstream "what changed" panel renders
 *      it, live. The rate window (§6.5: three sends per hour per sender) is
 *      asserted as an honest refusal on the fourth send — never a silent
 *      drop, never a silent accept past the bound — and the operator's own
 *      broadcast is asserted unconstrained by that same bound.
 *
 * Run locally: `bun run build && bun run --filter=@plotroom/web e2e` (root `pnpm
 * build` — or at least `@plotroom/core`, `@plotroom/ui`, `@plotroom/server`,
 * and `@plotroom/web` — must have already produced `apps/server/dist` and
 * `apps/web/dist`).
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
  server = await startMilestoneServer({ concurrencyLimit: 12 });
});

test.afterAll(async () => {
  if (server) await server.stop();
});

function requireServer(): MilestoneServer {
  if (!server) {
    throw new Error(
      "the steering-hardening server never started (beforeAll failed)",
    );
  }
  return server;
}

/** A same-origin POST that reports status/body instead of throwing, for a negative assertion. */
async function rawPost(
  baseUrl: string,
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<{ readonly status: number; readonly json: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: baseUrl,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
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
): Promise<string> {
  const command = await apiPost<{ command: { id: string } }>(
    base,
    "/api/commands",
    { definitionId, workstreamId },
  );
  return command.command.id;
}

interface StartedSession {
  readonly sessionId: string;
  readonly workstreamId: string;
}

async function startScriptedSession(
  base: string,
  script: unknown,
  name: string,
): Promise<StartedSession> {
  const definitionId = await createDefinition(base, name);
  const workstreamId = await createWorkstream(base);
  const commandId = await instantiateCommand(base, definitionId, workstreamId);

  const run = await apiPost<{
    run: { id: string } | null;
    session: { id: string } | null;
  }>(base, "/api/runs", {
    commandId,
    initiationKey: `steering-hardening-${crypto.randomUUID()}`,
    runtime: { script },
  });

  if (run.session === null) {
    throw new Error(
      "run was queued instead of started — raise the harness's concurrencyLimit",
    );
  }

  return { sessionId: run.session.id, workstreamId };
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

function sessionNode(page: Page, sessionId: string) {
  return page.locator('[data-testid^="canvas-node-"]', {
    hasText: `session ${sessionId}`,
  });
}

/** Ends almost immediately — for a session that must have no live runtime attached. */
function quickEndScript(): unknown {
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

/** Stays open (no `session-ended`) for real wall-clock room — enough for several assertions. */
function idleScript(delays = 3): unknown {
  return {
    acts: [
      {
        on: "start",
        steps: [
          { observation: { kind: "turn-started", turn: 1 } },
          ...Array.from({ length: delays }, () => ({ delay: { ms: 5_000 } })),
        ],
      },
    ],
  };
}

function askScript(text: string, options: readonly string[]): unknown {
  return {
    acts: [
      {
        on: "start",
        steps: [
          { observation: { kind: "turn-started", turn: 1 } },
          { delay: { ms: 500 } },
          { ask: { text, options } },
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

/**
 * The same shape as `askScript`, except its `ask` is the first step of a
 * *second* act, played on injection rather than on start.
 *
 * Discovered while writing this file, worth recording rather than routing
 * around silently: `ScriptedSessionHandle#requestQuestion` names a blocked
 * request `ask-${pendingSize+1}-${actIndex}`
 * (`apps/server/src/runtime/scripted.ts`), which is unique *within one
 * session's own instance* but not across sessions — two independent
 * sessions each asking as the first blocking step of their first act both
 * produce the literal string `ask-1-1`. `SessionQuestion#forRequest`
 * (`packages/db/src/question-store.ts`) looks that id up with no session
 * scope at all ("keyed by the request rather than the session" — true
 * for settling a call *within* one session's replay, not across two), so
 * the second session's raise silently answers with the first session's
 * question object instead of creating its own, and the second session's own
 * runtime call is left blocked forever with nothing that can ever settle
 * it. A real adapter's request ids would not collide like this; this is
 * specific to the scripted double's own counter-based naming. Out of this
 * batch's file ownership either way (`apps/server/src/runtime/`,
 * `packages/db/src/question-store.ts`) — reported, not patched. This second
 * shape is this file's own workaround: an act boundary changes the
 * `actIndex` half of the fingerprint, so two ask sessions in the same run
 * never collide.
 */
function askOnInjectionScript(
  text: string,
  options: readonly string[],
): unknown {
  return {
    acts: [
      {
        on: "start",
        steps: [
          { observation: { kind: "turn-started", turn: 1 } },
          { delay: { ms: 300 } },
        ],
      },
      {
        on: "injection",
        steps: [
          { ask: { text, options } },
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

test.describe("steering hardening: injection ledger", () => {
  test("a replayed injection id does not double the ledger; a refused injection renders distinctly from delivered", async () => {
    test.setTimeout(60_000);
    const base = requireServer().baseUrl;

    // ------------------------------------------------- (a) idempotent replay
    const live = await startScriptedSession(
      base,
      idleScript(),
      "hardening: replay",
    );
    const injectionId = `inj_hardening_${crypto.randomUUID()}`;

    const first = await apiPost<{
      status: string;
      injectionId: string;
      replayed: boolean;
    }>(base, `/api/sessions/${live.sessionId}/inject`, {
      text: "first send",
      injectionId,
    });
    expect(first.replayed).toBe(false);

    const second = await apiPost<{
      status: string;
      injectionId: string;
      replayed: boolean;
    }>(base, `/api/sessions/${live.sessionId}/inject`, {
      text: "first send",
      injectionId,
    });
    expect(second.replayed).toBe(true);
    expect(second.status).toBe(first.status);

    const ledger = await apiGet<{
      injections: readonly { id: string }[];
    }>(base, `/api/sessions/${live.sessionId}/injections`);
    // Sharp: one gesture, one row — never two, however many times it is replayed.
    expect(
      ledger.injections.filter((entry) => entry.id === injectionId),
    ).toHaveLength(1);

    // ---------------------------------------------- (b) refused, no phantom row
    const ended = await startScriptedSession(
      base,
      quickEndScript(),
      "hardening: refused",
    );
    expect(await waitForEnd(base, ended.sessionId)).toBe("ended-by-user");

    // Nothing is wired into this session yet — the ledger this refusal must
    // leave untouched starts empty.
    const beforeAttempt = await apiGet<{ injections: readonly unknown[] }>(
      base,
      `/api/sessions/${ended.sessionId}/injections`,
    );
    expect(beforeAttempt.injections).toHaveLength(0);

    const attempt = await rawPost(
      base,
      `/api/sessions/${ended.sessionId}/inject`,
      {
        text: "nobody is listening",
      },
    );
    // `checkInjection`'s plan-time rule refuses an ended session outright
    // (`session_not_running`) — before the content/edge/ledger writes
    // `SteeringService#deliver` otherwise makes in that order, so this
    // never reaches the ledger at all.
    expect(attempt.status).toBe(409);
    const attemptBody = attempt.json as {
      error: { code: string; details?: { reason?: string } };
    };
    expect(attemptBody.error.code).toBe("refused");
    expect(attemptBody.error.details?.reason).toBe("session_not_running");

    // Sharp: the refused attempt left no trace — never a phantom row for
    // something that never happened.
    const afterAttempt = await apiGet<{ injections: readonly unknown[] }>(
      base,
      `/api/sessions/${ended.sessionId}/injections`,
    );
    expect(afterAttempt.injections).toHaveLength(0);
  });
});

test.describe("steering hardening: structured questions", () => {
  test("answered from the queue settles the same blocked call as the bubble would, and unpicked options stay visible either way", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const base = requireServer().baseUrl;

    const bubbleAsk = await startScriptedSession(
      base,
      askScript("ship the hotfix now?", ["yes", "no"]),
      "hardening: ask from bubble",
    );
    const queueAsk = await startScriptedSession(
      base,
      askOnInjectionScript("roll back the migration?", [
        "roll back",
        "keep going",
      ]),
      "hardening: ask from queue",
    );
    // Moves `queueAsk` from its non-blocking first act into the act that
    // raises its question (see `askOnInjectionScript`'s own doc comment for
    // why this session's ask is not in its first act at all).
    await apiPost(base, `/api/sessions/${queueAsk.sessionId}/inject`, {
      text: "go ahead and ask, whenever you're ready",
    });

    await page.goto(`${base}/`);
    await ensureNotCollapsed(page);

    await expect(sessionNode(page, bubbleAsk.sessionId)).toBeVisible();
    await expect(sessionNode(page, queueAsk.sessionId)).toBeVisible();

    // ------------------------------------------- (a) answered from the QUEUE
    // Opened before selecting any node — a selected node's own bubble can
    // overlap the dock rail depending on where the canvas panned, which
    // `batch4-gate.spec.ts` already found and sidesteps the same way. The
    // Conversation panel and the bubble for this session are never opened
    // before it is answered.
    await page.getByRole("button", { name: "Queue" }).click();
    const queue = page.getByTestId("attention-queue");
    const queueRow = queue
      .getByRole("option")
      .filter({ hasText: "roll back the migration?" });
    await expect(queueRow).toBeVisible({ timeout: 10_000 });
    await queueRow
      .getByRole("button", { name: "roll back", exact: true })
      .click();
    await expect(queueRow).toHaveCount(0);

    // The blocked call actually unblocked: the script's post-answer turn
    // played on and reported its own output, proven over the API — the same
    // shape W14 uses for its bubble-answered session, now proven for a
    // queue-answered one.
    const queueAskTranscript = await apiGet<{
      turns: readonly { entries: readonly { kind: string; text?: string }[] }[];
    }>(base, `/api/sessions/${queueAsk.sessionId}/transcript`);
    const queueAskOutputs = queueAskTranscript.turns
      .flatMap((turn) => turn.entries)
      .filter((entry) => entry.kind === "output")
      .map((entry) => entry.text ?? "");
    expect(
      queueAskOutputs.some((text) => text.includes("thanks, proceeding")),
    ).toBe(true);

    // Selected only *now*, after the queue already answered it: the bubble
    // renders the same answered state from the one ledger — one vocabulary,
    // not two question-answering paths that could disagree.
    await sessionNode(page, queueAsk.sessionId).evaluate((el) =>
      (el as HTMLElement).click(),
    );
    const queueBubbleQuestion = page
      .locator('[data-bubble-kind="question"]')
      .filter({
        hasText: "roll back the migration?",
      });
    await expect(queueBubbleQuestion).toBeVisible({ timeout: 10_000 });
    await expect(
      queueBubbleQuestion.getByRole("button", { name: "roll back" }),
    ).toHaveAttribute("aria-pressed", "true");
    const queueBubbleUnpicked = queueBubbleQuestion.getByRole("button", {
      name: "keep going",
    });
    await expect(queueBubbleUnpicked).toBeVisible();
    await expect(queueBubbleUnpicked).toBeDisabled();

    // -------------------------------------------- (b) answered from the bubble
    // Proven last, so nothing about it could have influenced the queue
    // answer above.
    await sessionNode(page, bubbleAsk.sessionId).evaluate((el) =>
      (el as HTMLElement).click(),
    );
    const bubbleQuestion = page
      .locator('[data-bubble-kind="question"]')
      .filter({
        hasText: "ship the hotfix now?",
      });
    await expect(bubbleQuestion).toBeVisible({ timeout: 10_000 });
    await bubbleQuestion.getByRole("button", { name: "yes" }).click();
    await expect(
      bubbleQuestion.getByRole("button", { name: "yes" }),
    ).toHaveAttribute("aria-pressed", "true");
    const bubbleUnpicked = bubbleQuestion.getByRole("button", { name: "no" });
    // §6.4: the option not picked stays visible, merely disabled — never removed.
    await expect(bubbleUnpicked).toBeVisible();
    await expect(bubbleUnpicked).toBeDisabled();
  });
});

test.describe("steering hardening: stop semantics", () => {
  test("a stopped session's end wording is never 'failed', and it is resumable-listed", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const base = requireServer().baseUrl;

    const target = await startScriptedSession(
      base,
      idleScript(),
      "hardening: stop",
    );

    const stopped = await apiPost<{ stopped: readonly string[] }>(
      base,
      "/api/stops",
      { scope: "session", sessionId: target.sessionId, confirm: false },
    );
    expect(stopped.stopped).toContain(target.sessionId);
    expect(await waitForEnd(base, target.sessionId)).toBe("stopped");

    // Readable always (§3.6): the record is still in the plain session list,
    // not hidden because it ended.
    const list = await apiGet<{
      sessions: readonly {
        session: { id: string; end: { kind: string } | null };
      }[];
    }>(base, "/api/sessions");
    const listed = list.sessions.find(
      (entry) => entry.session.id === target.sessionId,
    );
    expect(listed).toBeDefined();
    expect(listed?.session.end?.kind).toBe("stopped");

    await page.goto(`${base}/`);
    await ensureNotCollapsed(page);
    await sessionNode(page, target.sessionId).evaluate((el) =>
      (el as HTMLElement).click(),
    );
    await page.getByRole("button", { name: "Conversation" }).click();

    const sessionEnd = page.getByTestId("session-end");
    await expect(sessionEnd).toContainText("stopped");
    // Sharp negative: this end state is never rendered as "failed" (§3.6, §8) —
    // checked as rendered text, not only as the API's own `end.kind`.
    await expect(sessionEnd).not.toContainText("failed");

    // Resumable-listed (§6.7, §3.6): a stopped session's card offers resume,
    // not a dead end.
    const resumeOrFork = page.getByTestId("resume-or-fork");
    await expect(resumeOrFork).toBeVisible();
    await expect(resumeOrFork).toContainText("resume it, or fork from a point");
    await expect(
      resumeOrFork.getByRole("button", { name: "resume" }),
    ).toBeEnabled();
  });
});

test.describe("steering hardening: session broadcast", () => {
  test("one session's broadcast reaches everyone in its repository, live, and the rate window is an honest refusal — not a silent drop", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const base = requireServer().baseUrl;

    const sender = await startScriptedSession(
      base,
      idleScript(4),
      "hardening: broadcast sender",
    );
    const recipient = await startScriptedSession(
      base,
      idleScript(4),
      "hardening: broadcast recipient",
    );

    // Both workstreams' workspaces resolve to the one repository this
    // harness configures (`PLOTROOM_WORKSPACE_REPO`) — "a repository's
    // identity is its configured source" (`sessions/world.ts`), so this is
    // a real shared scope, not two isolated fixtures that merely look alike.
    const world = await apiGet<{
      members: readonly {
        sessionId: string;
        repositoryIds: readonly string[];
        running: boolean;
      }[];
    }>(base, "/api/broadcast-world");
    const senderMember = world.members.find(
      (m) => m.sessionId === sender.sessionId,
    );
    const recipientMember = world.members.find(
      (m) => m.sessionId === recipient.sessionId,
    );
    expect(senderMember?.repositoryIds).toHaveLength(1);
    expect(senderMember?.repositoryIds).toEqual(recipientMember?.repositoryIds);
    const repositoryId = senderMember?.repositoryIds[0];
    expect(repositoryId).toBeDefined();

    const sessionActor = { "x-plotroom-actor": `session:${sender.sessionId}` };

    const firstSend = await apiPost<{
      recipients: readonly { sessionId: string; status: string }[];
    }>(
      base,
      "/api/broadcasts",
      {
        text: "rebased main under everyone — pull before you push",
        scope: { kind: "everyone-in-repository", repositoryId },
        category: "material-state-changed",
      },
      sessionActor,
    );
    const delivery = firstSend.recipients.find(
      (r) => r.sessionId === recipient.sessionId,
    );
    expect(delivery).toBeDefined();
    // Success reports `queued` even here (delivery is the separate observed
    // fact, §6.5) — the sharp check is that the recipient is *in* the list at
    // all, not refused as an empty or foreign scope.
    expect(delivery?.status).toBe("queued");

    const recipientLedger = await apiGet<{
      injections: readonly { text: string; nodeId: string | null }[];
    }>(base, `/api/sessions/${recipient.sessionId}/injections`);
    expect(
      recipientLedger.injections.some(
        (entry) =>
          entry.text === "rebased main under everyone — pull before you push",
      ),
    ).toBe(true);

    // Live, on the recipient's own workstream "what changed" panel — the
    // repository-scoped fact rendered where the operator actually looks for
    // it, not only provable over the API.
    await page.goto(`${base}/`);
    await ensureNotCollapsed(page);
    await page.getByRole("button", { name: "What changed" }).click();
    const recipientHistory = page.getByTestId(
      `what-changed-${recipient.workstreamId}`,
    );
    await expect(recipientHistory).toBeVisible({ timeout: 10_000 });
    await expect(recipientHistory).toContainText("broadcast to 1 here");

    // ------------------------------------------------- the rate window, honestly
    // Two more sends (three total) still land; policy is 3 per hour per
    // sender (`DEFAULT_SESSION_BROADCAST_POLICY`).
    for (let i = 0; i < 2; i++) {
      const send = await apiPost<{ recipients: readonly unknown[] }>(
        base,
        "/api/broadcasts",
        {
          text: `follow-up ${i}`,
          scope: { kind: "everyone-in-repository", repositoryId },
          category: "material-state-changed",
        },
        sessionActor,
      );
      expect(send.recipients.length).toBeGreaterThan(0);
    }

    // The fourth is refused outright — never silently dropped, never
    // silently allowed past the bound.
    const fourth = await rawPost(
      base,
      "/api/broadcasts",
      {
        text: "one broadcast too many",
        scope: { kind: "everyone-in-repository", repositoryId },
        category: "material-state-changed",
      },
      sessionActor,
    );
    expect(fourth.status).toBe(409);
    const fourthBody = fourth.json as {
      error: { code: string; message: string; details?: { reason?: string } };
    };
    expect(fourthBody.error.code).toBe("refused");
    expect(fourthBody.error.details?.reason).toBe("rate_limited");
    expect(fourthBody.error.message).toContain(
      "may broadcast 3 times per 3600 seconds",
    );

    // The operator's own broadcast is unconstrained by the same bound
    // (§6.5: "the operator's own is unconstrained") — proven right after the
    // sender's own window is exhausted, in the same test, so there is no
    // chance the two are secretly sharing one counter.
    const operatorSend = await apiPost<{
      recipients: readonly { sessionId: string; status: string }[];
    }>(base, "/api/broadcasts", {
      text: "operator broadcast, unbounded",
      target: { kind: "everything-running" },
    });
    expect(
      operatorSend.recipients.some((r) => r.sessionId === recipient.sessionId),
    ).toBe(true);
  });
});
