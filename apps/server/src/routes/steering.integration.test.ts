import { expect } from "vitest";
import { afterEach, describe, it } from "bun:test";
import type { RuntimeScript } from "../runtime/scripted.js";
import {
  at,
  boot,
  cleanupHarnesses,
  command,
  endedSession,
  list,
  repository,
  run,
  str,
  waitFor,
  type Harness,
} from "../testing/harness.js";

/**
 * Steering in flight, over the real app (§6.5, §6.4, §4.2, §6.7).
 *
 * The domain is `@plotroom/core`'s and has its own suite; what these prove is that
 * the rules are *reached* — that an injection really lands on the graph with its
 * author before the runtime is touched, that a question really blocks until the
 * operator answers and never resolves itself, that a session's broadcast is really
 * bounded by the scope it stands in, and that the widest stop really confirms.
 */
afterEach(cleanupHarnesses);

/** Live, and plays a second act when something is injected. */
const takesInjections: RuntimeScript = {
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
            usage: { inputTokens: 8, outputTokens: 2, costUsd: 0.001 },
          },
        },
      ],
    },
    {
      on: "injection",
      steps: [
        { observation: { kind: "turn-started", turn: 2 } },
        { observation: { kind: "output-delta", text: "taking that on board" } },
        {
          observation: {
            kind: "turn-ended",
            turn: 2,
            usage: { inputTokens: 4, outputTokens: 2, costUsd: 0.002 },
          },
        },
      ],
    },
  ],
};

/**
 * Live, and spends nothing: no `costUsd` and no usage at all, so a recipient's
 * accounting never moves and no induced charge fires.
 */
const costsNothing: RuntimeScript = {
  acts: [
    {
      on: "start",
      steps: [
        { observation: { kind: "turn-started", turn: 1 } },
        { observation: { kind: "output-delta", text: "working" } },
      ],
    },
    {
      on: "injection",
      steps: [{ observation: { kind: "output-delta", text: "noted" } }],
    },
  ],
};

/** Asks the operator a question and stops there — which is what asking is. */
const asks: RuntimeScript = {
  acts: [
    {
      on: "start",
      steps: [
        { observation: { kind: "turn-started", turn: 1 } },
        { ask: { text: "ship it?", options: ["ship", "hold"] } },
      ],
    },
  ],
};

async function bootWith(
  script: RuntimeScript,
  overrides: Record<string, unknown> = {},
): Promise<Harness> {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "plotroom-steer-"));
  const path = join(dir, "script.json");
  writeFileSync(path, JSON.stringify(script), "utf8");

  return boot({
    ...repository(),
    runtime: { adapterId: "scripted", scriptPath: path },
    ...overrides,
  });
}

/** A live session in its own workstream, plus its session node. */
async function liveSession(
  harness: Harness,
  script: RuntimeScript,
  options: { readonly workstreamId?: string; readonly name?: string } = {},
): Promise<{ readonly sessionId: string; readonly workstream: string }> {
  const fixture = await command(harness, {
    lifecycle: "open",
    ...(options.workstreamId === undefined
      ? {}
      : { workstreamId: options.workstreamId }),
    ...(options.name === undefined ? {} : { name: options.name }),
  });
  const started = await run(harness, fixture.commandId, script);
  return {
    sessionId: str(started, "session.id"),
    workstream: fixture.workstream,
  };
}

describe("injection (§6.5)", () => {
  it("leaves content, a node, and an authored edge, then queues the turn", async () => {
    const harness = await bootWith(takesInjections);
    const { sessionId } = await liveSession(harness, takesInjections);

    const injected = await harness.ok(`/sessions/${sessionId}/inject`, {
      method: "POST",
      body: { text: "the ticket changed: use the new endpoint" },
    });

    // Queued, not delivered: delivery is the separate observed fact (§6.5).
    expect(at(injected, "status")).toBe("queued");

    // Three writes, all of them (§6.5, principle 5): the content is on the graph
    // permanently, with a node, wired to the session.
    const snapshot = await harness.ok("/snapshot");
    const node = list(snapshot, "nodes").find(
      (candidate) => at(candidate, "id") === str(injected, "nodeId"),
    );
    expect(at(node, "role")).toBe("content");

    const edge = list(snapshot, "edges").find(
      (candidate) => at(candidate, "id") === str(injected, "edgeId"),
    );
    expect(at(edge, "kind")).toBe("context");
    // §15-2: steering is authoring, and the edge says who.
    expect(at(edge, "author.kind")).toBe("human");

    // The content itself is readable, so a later reader finds what was said.
    const object = await harness.ok(`/objects/${str(injected, "objectId")}`);
    expect(String(at(object, "content.renderings.agentContent"))).toContain(
      "use the new endpoint",
    );

    // And the ledger moves from queued to delivered on the observed fact, which is
    // what a surface renders rather than assuming delivery from acceptance.
    const delivered = await waitFor(async () => {
      const ledger = list(
        await harness.ok(`/sessions/${sessionId}/injections`),
        "injections",
      ).find((entry) => at(entry, "id") === str(injected, "injectionId"));
      return at(ledger, "deliveredAt") === null ? null : ledger;
    }, "the injection to be observed delivered");

    expect(at(delivered, "deliveredAt")).not.toBeNull();
    expect(at(delivered, "author.kind")).toBe("human");
  });

  it("is the same turn when the same gesture arrives twice (principle 9)", async () => {
    const harness = await bootWith(takesInjections);
    const { sessionId } = await liveSession(harness, takesInjections);

    const first = await harness.call(`/sessions/${sessionId}/inject`, {
      method: "POST",
      body: { text: "say it once", injectionId: "inj-one-gesture" },
    });
    const again = await harness.call(`/sessions/${sessionId}/inject`, {
      method: "POST",
      body: { text: "say it once", injectionId: "inj-one-gesture" },
    });

    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(at(again.body, "replayed")).toBe(true);

    // One entry, not two: a retry must not produce a second turn.
    const ledger = list(
      await harness.ok(`/sessions/${sessionId}/injections`),
      "injections",
    );
    expect(
      ledger.filter((entry) => at(entry, "id") === "inj-one-gesture"),
    ).toHaveLength(1);
  });

  it("refuses a session steering its own chain, and permits an out-of-chain peer", async () => {
    const harness = await bootWith(takesInjections);
    const first = await liveSession(harness, takesInjections, { name: "A" });
    const second = await liveSession(harness, takesInjections, { name: "B" });

    // Into itself: principle 1's asymmetry, refused by `checkInjection` and
    // reported with that predicate's own reason.
    const own = await harness.call(`/sessions/${first.sessionId}/inject`, {
      method: "POST",
      body: { text: "wire me into myself" },
      actor: `session:${first.sessionId}`,
    });
    expect(own.status).toBe(409);
    expect(at(own.body, "error.details.reason")).toBe("own_chain");

    // Into an out-of-chain peer: "sessions outside each other's chains exchange
    // context freely — that is collaboration" (principle 1).
    const peer = await harness.call(`/sessions/${second.sessionId}/inject`, {
      method: "POST",
      body: { text: "the port you wanted is free now" },
      actor: `session:${first.sessionId}`,
    });
    expect(peer.status).toBe(201);

    const edge = list(await harness.ok("/snapshot"), "edges").find(
      (candidate) => at(candidate, "id") === str(peer.body, "edgeId"),
    );
    expect(at(edge, "author.kind")).toBe("session");
    expect(at(edge, "author.sessionId")).toBe(first.sessionId);
  });

  it("refuses steering a session that has ended", async () => {
    const harness = await bootWith(takesInjections);
    const { sessionId } = await liveSession(harness, takesInjections);
    await harness.ok(`/sessions/${sessionId}/stop`, {
      method: "POST",
      body: {},
    });
    await endedSession(harness, sessionId);

    const refused = await harness.call(`/sessions/${sessionId}/inject`, {
      method: "POST",
      body: { text: "too late" },
    });

    expect(refused.status).toBe(409);
    expect(at(refused.body, "error.details.reason")).toBe(
      "session_not_running",
    );
  });
});

describe("structured questions (§6.4)", () => {
  it("raises a runtime's question and blocks until the operator answers", async () => {
    const harness = await bootWith(asks);
    const { sessionId } = await liveSession(harness, asks);

    // Raised, not answered. Before the driver learned to tell a question from a
    // tool permission this was denied instantly by the write gate.
    const raised = await waitFor(async () => {
      const questions = list(
        await harness.ok(`/sessions/${sessionId}/questions`),
        "questions",
      );
      return questions.length > 0 ? questions[0] : null;
    }, "the runtime's question to be raised");

    expect(at(raised, "question.text")).toBe("ship it?");
    expect(at(raised, "question.answer")).toBeNull();
    // It names the blocked call, which is what makes answering settle *that* call.
    expect(at(raised, "question.requestId")).not.toBeNull();
    // Every option is still a path not taken while nothing is answered (§6.4).
    expect(list(raised, "pathsNotTaken")).toHaveLength(2);

    // No timer resolves it. The session is still waiting some time later, which is
    // the whole of §6.4's prohibition observed from outside.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const stillWaiting = list(
      await harness.ok(`/sessions/${sessionId}/questions`),
      "questions",
    )[0];
    expect(at(stillWaiting, "question.answer")).toBeNull();

    const questionId = str(raised, "question.id");
    const answered = await harness.ok(`/questions/${questionId}/answer`, {
      method: "POST",
      body: { optionId: "opt-1" },
    });

    expect(at(answered, "question.answer.optionId")).toBe("opt-1");
    // The blocked runtime call was settled, not just recorded.
    expect(at(answered, "settled")).toBe(true);
    // The structured payload names what was declined as well as what was picked.
    expect(at(answered, "answer.answer.label")).toBe("ship");
    expect(list(answered, "answer.pathsNotTaken")).toHaveLength(1);
    expect(at(answered, "answer.pathsNotTaken.0.label")).toBe("hold");

    // Unpicked options remain visible after the answer (§6.4).
    expect(list(answered, "pathsNotTaken")).toHaveLength(1);

    // And the session heard it: the scripted runtime says what it was told.
    await waitFor(async () => {
      const transcript = await harness.ok(`/sessions/${sessionId}/transcript`);
      return String(at(transcript, "renderings.agentContent")).includes(
        "the operator chose: ship",
      )
        ? transcript
        : null;
    }, "the answer to reach the session");
  });

  it("refuses a session answering a question, and a second answer", async () => {
    const harness = await bootWith(asks);
    const { sessionId } = await liveSession(harness, asks);

    const raised = await waitFor(async () => {
      const questions = list(
        await harness.ok(`/sessions/${sessionId}/questions`),
        "questions",
      );
      return questions.length > 0 ? questions[0] : null;
    }, "the question to be raised");
    const questionId = str(raised, "question.id");

    // A session answering a question posed to the operator would be principle 1
    // with extra steps.
    const bySession = await harness.call(`/questions/${questionId}/answer`, {
      method: "POST",
      body: { optionId: "opt-1" },
      actor: `session:${sessionId}`,
    });
    expect(bySession.status).toBe(409);
    expect(at(bySession.body, "error.details.reason")).toBe("human_only");

    await harness.ok(`/questions/${questionId}/answer`, {
      method: "POST",
      body: { optionId: "opt-1" },
    });

    // A second answer would rewrite what the session was told (principle 9).
    const twice = await harness.call(`/questions/${questionId}/answer`, {
      method: "POST",
      body: { optionId: "opt-2" },
    });
    expect(twice.status).toBe(409);
    expect(at(twice.body, "error.details.reason")).toBe("already_answered");
  });

  it("refuses an option the question never offered, and a question with none", async () => {
    const harness = await bootWith(takesInjections);
    const { sessionId } = await liveSession(harness, takesInjections);

    const asked = await harness.ok(`/sessions/${sessionId}/questions`, {
      method: "POST",
      body: { text: "which branch?", options: ["main", "develop"] },
      actor: `session:${sessionId}`,
    });
    const questionId = str(asked, "question.id");
    // An HTTP-raised question blocks no call, and says so rather than pretending.
    expect(at(asked, "question.requestId")).toBeNull();

    const unknown = await harness.call(`/questions/${questionId}/answer`, {
      method: "POST",
      body: { optionId: "opt-9" },
    });
    expect(unknown.status).toBe(409);
    expect(at(unknown.body, "error.details.reason")).toBe("unknown_option");

    const answered = await harness.ok(`/questions/${questionId}/answer`, {
      method: "POST",
      body: { optionId: "opt-1" },
    });
    // Nothing was blocked on it, so nothing was settled — reported, not assumed.
    expect(at(answered, "settled")).toBe(false);

    const empty = await harness.call(`/sessions/${sessionId}/questions`, {
      method: "POST",
      body: { text: "well?", options: [] },
    });
    // Zod refuses an empty list before core has to: a question with nothing to
    // pick is prose either way.
    expect(empty.status).toBe(400);
  });
});

describe("broadcast (§6.5)", () => {
  it("sends the operator's broadcast to everything running, once", async () => {
    const harness = await bootWith(takesInjections);
    const first = await liveSession(harness, takesInjections, { name: "A" });
    const second = await liveSession(harness, takesInjections, { name: "B" });

    const sent = await harness.ok("/broadcasts", {
      method: "POST",
      body: {
        text: "pausing deploys for the next hour",
        target: { kind: "everything-running" },
      },
    });

    const recipients = list(sent, "recipients");
    expect(recipients).toHaveLength(2);
    expect(recipients.every((one) => at(one, "status") === "queued")).toBe(
      true,
    );
    // No category on the operator's path, and no chain to charge (§6.5).
    expect(at(sent, "category")).toBeNull();
    expect(list(sent, "spendChargedTo")).toHaveLength(0);

    // One content node wired into both, not two copies: "the same content, once".
    const edges = list(await harness.ok("/snapshot"), "edges").filter(
      (edge) => at(edge, "from") === str(sent, "contentNodeId"),
    );
    expect(edges).toHaveLength(2);

    for (const sessionId of [first.sessionId, second.sessionId]) {
      const ledger = list(
        await harness.ok(`/sessions/${sessionId}/injections`),
        "injections",
      );
      expect(ledger).toHaveLength(1);
    }
  });

  it("refuses a session that names recipients instead of a scope", async () => {
    const harness = await bootWith(takesInjections);
    const { sessionId } = await liveSession(harness, takesInjections);

    const refused = await harness.call("/broadcasts", {
      method: "POST",
      body: {
        text: "just you",
        target: { kind: "selection", sessionIds: [sessionId] },
      },
      actor: `session:${sessionId}`,
    });

    // §6.5's core rule: a session names a scope of shared material state, never a
    // recipient list. Refused rather than reinterpreted, so the attempt is visible.
    expect(refused.status).toBe(400);
  });

  it("refuses a scope the sender does not stand in (scope_not_shared)", async () => {
    const harness = await bootWith(takesInjections);
    const { sessionId } = await liveSession(harness, takesInjections);

    const refused = await harness.call("/broadcasts", {
      method: "POST",
      body: {
        text: "everything is fine",
        scope: {
          kind: "everyone-in-workspace",
          workspaceId: "wsp_somewhere_else",
        },
        category: "material-state-changed",
      },
      actor: `session:${sessionId}`,
    });

    expect(refused.status).toBe(409);
    expect(at(refused.body, "error.details.reason")).toBe("scope_not_shared");
  });

  it("reaches peers in the same repository and charges the sender's chain", async () => {
    // One repository, two workstreams: two worktrees of the same checkout are the
    // same repository, which is exactly what "everyone in this repository" is about.
    const harness = await bootWith(takesInjections);
    const sender = await liveSession(harness, takesInjections, { name: "A" });
    const peer = await liveSession(harness, takesInjections, { name: "B" });

    const world = await harness.ok(`/sessions/${sender.sessionId}`);
    expect(at(world, "session.id")).toBe(sender.sessionId);

    // The repository id the server derives — read from the broadcast world rather
    // than guessed, because a wrong join is what would widen what may be declared.
    const repositories = list(await harness.ok("/broadcast-world"), "members")
      .filter((member) => at(member, "sessionId") === sender.sessionId)
      .flatMap((member) => list(member, "repositoryIds"));
    expect(repositories.length).toBeGreaterThan(0);

    const sent = await harness.ok("/broadcasts", {
      method: "POST",
      body: {
        text: "I rebased the shared branch",
        scope: {
          kind: "everyone-in-repository",
          repositoryId: String(repositories[0]),
        },
        category: "material-state-changed",
      },
      actor: `session:${sender.sessionId}`,
    });

    // The peer, and not the sender: a broadcast is to everyone *else* in scope.
    const recipients = list(sent, "recipients").map((one) =>
      at(one, "sessionId"),
    );
    expect(recipients).toContain(peer.sessionId);
    expect(recipients).not.toContain(sender.sessionId);

    // The category is on the content, so a reader who finds the node knows what
    // kind of thing it is (§6.5).
    expect(at(sent, "category")).toBe("material-state-changed");

    // Induced spend is charged to the sender's chain (principle 2).
    expect(list(sent, "spendChargedTo")).toContain(sender.sessionId);
    await waitFor(async () => {
      const spend = await harness.ok(`/sessions/${sender.sessionId}/spend`);
      const fromPeer = list(spend, "entries").find(
        (entry) => at(entry, "sourceSessionId") === peer.sessionId,
      );
      return fromPeer ?? null;
    }, "the peer's induced turn to be charged to the sender");
  });

  it("bounds a session to its window (rate_limited)", async () => {
    const harness = await bootWith(takesInjections);
    const sender = await liveSession(harness, takesInjections, { name: "A" });
    await liveSession(harness, takesInjections, { name: "B" });

    const repositoryId = String(
      list(await harness.ok("/broadcast-world"), "members")
        .filter((member) => at(member, "sessionId") === sender.sessionId)
        .flatMap((member) => list(member, "repositoryIds"))[0],
    );

    const send = (n: number) =>
      harness.call("/broadcasts", {
        method: "POST",
        body: {
          text: `send ${n}`,
          scope: { kind: "everyone-in-repository", repositoryId },
          category: "shared-resource-warning",
        },
        actor: `session:${sender.sessionId}`,
      });

    // Three per hour is the decided default: enough for an emergency and its
    // correction, few enough to be useless as a channel (§6.5).
    for (const n of [1, 2, 3]) {
      expect((await send(n)).status).toBe(201);
    }

    const fourth = await send(4);
    expect(fourth.status).toBe(409);
    expect(at(fourth.body, "error.details.reason")).toBe("rate_limited");
  });
});

describe("a broadcast replays rather than refusing (principle 9)", () => {
  it("answers a repeated key from what the first send recorded", async () => {
    const harness = await bootWith(takesInjections);
    const first = await liveSession(harness, takesInjections, { name: "A" });
    await liveSession(harness, takesInjections, { name: "B" });

    const sent = await harness.call("/broadcasts", {
      method: "POST",
      body: {
        text: "pausing deploys",
        target: { kind: "everything-running" },
        broadcastId: "bcast-one-gesture",
      },
    });
    expect(sent.status).toBe(201);
    expect(at(sent.body, "replayed")).toBe(false);

    // The same gesture again. This used to be refused `already_sent`, which is a
    // different rule from the one inject, resume, and fork keep — so a caller
    // retrying after a dropped response was told its broadcast failed when it had
    // landed, which is the failure principle 9 exists to prevent.
    const again = await harness.call("/broadcasts", {
      method: "POST",
      body: {
        text: "pausing deploys",
        target: { kind: "everything-running" },
        broadcastId: "bcast-one-gesture",
      },
    });

    expect(again.status).toBe(200);
    expect(at(again.body, "replayed")).toBe(true);
    expect(at(again.body, "broadcastId")).toBe("bcast-one-gesture");
    expect(list(again.body, "recipients")).toHaveLength(2);

    // And nothing was re-delivered: the same content is still exactly one turn for
    // every recipient.
    for (const sessionId of [first.sessionId]) {
      const ledger = list(
        await harness.ok(`/sessions/${sessionId}/injections`),
        "injections",
      );
      expect(ledger).toHaveLength(1);
    }

    const edges = list(await harness.ok("/snapshot"), "edges").filter(
      (edge) => at(edge, "from") === str(again.body, "contentNodeId"),
    );
    expect(edges).toHaveLength(2);
  });

  it("replays only for the sender who sent it", async () => {
    const harness = await bootWith(costsNothing);
    const sender = await liveSession(harness, costsNothing, { name: "A" });
    const other = await liveSession(harness, costsNothing, { name: "B" });

    const repositoryId = String(
      list(await harness.ok("/broadcast-world"), "members")
        .filter((member) => at(member, "sessionId") === sender.sessionId)
        .flatMap((member) => list(member, "repositoryIds"))[0],
    );

    await harness.ok("/broadcasts", {
      method: "POST",
      body: {
        text: "the shared branch moved",
        scope: { kind: "everyone-in-repository", repositoryId },
        category: "material-state-changed",
        broadcastId: "bcast-mine",
      },
      actor: `session:${sender.sessionId}`,
    });

    // A broadcast id is the caller's own, so another session naming it would be
    // handed this broadcast's recipient list — a read of who is running and sharing
    // state, which is exactly what a session may not address (§6.5).
    const byOther = await harness.call("/broadcasts", {
      method: "POST",
      body: {
        text: "the shared branch moved",
        scope: { kind: "everyone-in-repository", repositoryId },
        category: "material-state-changed",
        broadcastId: "bcast-mine",
      },
      actor: `session:${other.sessionId}`,
    });
    expect(byOther.status).toBe(409);
    expect(at(byOther.body, "error.details.reason")).toBe("not_your_broadcast");

    // The sender's own retry replays, and so does the operator's: they see every send
    // by construction (§6.5's operator-visible clause).
    const mine = await harness.call("/broadcasts", {
      method: "POST",
      body: {
        text: "the shared branch moved",
        scope: { kind: "everyone-in-repository", repositoryId },
        category: "material-state-changed",
        broadcastId: "bcast-mine",
      },
      actor: `session:${sender.sessionId}`,
    });
    expect(mine.status).toBe(200);
    expect(at(mine.body, "replayed")).toBe(true);

    const asOperator = await harness.call("/broadcasts", {
      method: "POST",
      body: {
        text: "the shared branch moved",
        target: { kind: "everything-running" },
        broadcastId: "bcast-mine",
      },
    });
    expect(asOperator.status).toBe(200);
    expect(at(asOperator.body, "replayed")).toBe(true);
  });

  it("excludes a refused delivery from what the sender is charged for", async () => {
    // A delivery the runtime never received induced no turn, so billing the sender
    // for it would charge them for work their broadcast did not cause — the same
    // hole in principle 2's transitive guarantee, pointing the other way (§6.5).
    //
    // The script costs nothing, deliberately: an induced charge fires as soon as a
    // recipient's accounting moves, so a priced turn would settle both deliveries
    // before there was anything to exclude. With nothing spent, both rows are still
    // uncharged and the query's exclusion is the only thing that distinguishes them.
    const harness = await bootWith(costsNothing);
    const sender = await liveSession(harness, costsNothing, { name: "A" });
    const second = await liveSession(harness, costsNothing, { name: "B" });

    const repositoryId = String(
      list(await harness.ok("/broadcast-world"), "members")
        .filter((member) => at(member, "sessionId") === sender.sessionId)
        .flatMap((member) => list(member, "repositoryIds"))[0],
    );

    const sent = await harness.ok("/broadcasts", {
      method: "POST",
      body: {
        text: "the shared branch moved",
        scope: { kind: "everyone-in-repository", repositoryId },
        category: "material-state-changed",
      },
      actor: `session:${sender.sessionId}`,
    });

    const recipients = list(sent, "recipients").map((one) =>
      at(one, "sessionId"),
    );
    expect(recipients).toEqual([second.sessionId]);

    // Started after the send, so it is not a recipient of it and its row below is
    // the only one this test writes by hand.
    const third = await liveSession(harness, costsNothing, { name: "C" });

    const { openDatabase, BroadcastStore, SessionStore } =
      await import("@plotroom/db");
    const state = openDatabase({ stateDir: harness.stateDir });
    try {
      const broadcasts = new BroadcastStore(state);
      const sessions = new SessionStore(state);
      const broadcastId = str(sent, "broadcastId");

      // The delivered one is uncharged and outstanding: nothing was spent, so there
      // is nothing to charge yet and the row is still waiting for a turn.
      expect(broadcasts.unchargedFor(second.sessionId)).toHaveLength(1);

      // A delivery that was refused rather than delivered. Constructed rather than
      // provoked, because the scripted runtime accepts every injection: a delivered
      // injection cannot *become* refused (`markRefused` refuses to un-deliver one,
      // correctly), so the state under test only exists where the runtime was gone
      // at delivery time — which is what `deliver` records and what a restart
      // produces. The rows are the same rows either way, and the query is what is
      // being tested.
      const contentNodeId = str(sent, "contentNodeId");
      const refusedInjectionId = `inj_${broadcastId}_refused`;
      sessions.queueInjection({
        id: refusedInjectionId as never,
        sessionId: third.sessionId,
        origin: "steering",
        author: { kind: "session", sessionId: sender.sessionId as never },
        nodeId: contentNodeId,
        text: "the shared branch moved",
        queuedAt: Math.floor(Date.now() / 1000),
      });
      sessions.markRefused(
        refusedInjectionId,
        Math.floor(Date.now() / 1000),
        "no live runtime is attached to this session",
      );
      state.sqlite
        .prepare(
          "INSERT INTO broadcast_recipients (broadcast_id, session_id, workstream_id, injection_id, baseline_cost_micros, induced_micros) VALUES (?, ?, ?, ?, 0, NULL)",
        )
        .run(
          broadcastId,
          third.sessionId,
          third.workstream,
          refusedInjectionId,
        );

      // The refused one charges nobody; the one that arrived is still the sender's
      // to pay for.
      expect(broadcasts.unchargedFor(third.sessionId)).toHaveLength(0);
      expect(broadcasts.unchargedFor(second.sessionId)).toHaveLength(1);
    } finally {
      state.close();
    }
  });
});

describe("stop at three scopes (§6.7)", () => {
  it("names the count, disables when quiet, and confirms at the widest scope", async () => {
    const harness = await bootWith(takesInjections);
    const first = await liveSession(harness, takesInjections, { name: "A" });
    await liveSession(harness, takesInjections, {
      workstreamId: first.workstream,
      name: "B",
    });

    // The button's own state, before the gesture is made.
    const workstream = await harness.ok(
      `/stops/preview?scope=workstream&workstreamId=${first.workstream}`,
    );
    expect(at(workstream, "count")).toBe(2);
    expect(at(workstream, "enabled")).toBe(true);
    // A workstream stop does not confirm: making it would train the operator to
    // dismiss the confirmation that matters.
    expect(at(workstream, "requiresConfirmation")).toBe(false);

    const everything = await harness.ok("/stops/preview?scope=everything");
    expect(at(everything, "requiresConfirmation")).toBe(true);

    // The widest scope is refused without its confirmation (§6.7).
    const unconfirmed = await harness.call("/stops", {
      method: "POST",
      body: { scope: "everything" },
    });
    expect(unconfirmed.status).toBe(409);
    expect(at(unconfirmed.body, "error.details.reason")).toBe(
      "confirmation_required",
    );

    const stopped = await harness.ok("/stops", {
      method: "POST",
      body: { scope: "everything", confirm: true },
    });
    expect(list(stopped, "stopped")).toHaveLength(2);

    // Disabled, not silent, once nothing is running.
    const quiet = await harness.ok("/stops/preview?scope=everything");
    expect(at(quiet, "enabled")).toBe(false);
    expect(at(quiet, "count")).toBe(0);

    const refused = await harness.call("/stops", {
      method: "POST",
      body: { scope: "everything", confirm: true },
    });
    expect(refused.status).toBe(409);
    expect(at(refused.body, "error.details.reason")).toBe("nothing_running");
  });
});

describe("batch gestures (§4.2)", () => {
  it("sends one prompt to many, keyed from the batch key", async () => {
    const harness = await bootWith(takesInjections);
    const first = await liveSession(harness, takesInjections, { name: "A" });
    const second = await liveSession(harness, takesInjections, { name: "B" });

    const batch = await harness.ok("/batches", {
      method: "POST",
      body: {
        kind: "inject",
        batchKey: "one-prompt",
        sessionIds: [first.sessionId, second.sessionId],
        prompt: "stop what you are doing and read the new brief",
      },
    });

    const members = list(batch, "members");
    expect(members).toHaveLength(2);
    expect(members.every((member) => at(member, "ok") === true)).toBe(true);
    // Every member's key derives from the batch key, so a half-failed batch is
    // replayable without doubling anybody's turn (principle 9).
    expect(String(at(members[0], "memberKey"))).toContain("one-prompt:");

    for (const sessionId of [first.sessionId, second.sessionId]) {
      const ledger = list(
        await harness.ok(`/sessions/${sessionId}/injections`),
        "injections",
      );
      expect(ledger).toHaveLength(1);
    }
  });

  it("skips a member that cannot take the gesture rather than failing the rest", async () => {
    const harness = await bootWith(takesInjections);
    const live = await liveSession(harness, takesInjections, { name: "A" });
    const ended = await liveSession(harness, takesInjections, { name: "B" });

    await harness.ok(`/sessions/${ended.sessionId}/stop`, {
      method: "POST",
      body: {},
    });
    await endedSession(harness, ended.sessionId);

    const batch = await harness.ok("/batches", {
      method: "POST",
      body: {
        kind: "inject",
        batchKey: "partial",
        sessionIds: [live.sessionId, ended.sessionId],
        prompt: "one prompt",
      },
    });

    // Partial by design (§4.2): the ended session is skipped with a reason, and the
    // live one still got the prompt.
    expect(list(batch, "members")).toHaveLength(1);
    const skipped = list(batch, "skipped");
    expect(skipped).toHaveLength(1);
    expect(at(skipped[0], "sessionId")).toBe(ended.sessionId);
    expect(String(at(skipped[0], "reason")).length).toBeGreaterThan(0);
  });

  it("refuses one prompt to many with no prompt", async () => {
    const harness = await bootWith(takesInjections);
    const { sessionId } = await liveSession(harness, takesInjections);

    const refused = await harness.call("/batches", {
      method: "POST",
      body: { kind: "inject", batchKey: "no-prompt", sessionIds: [sessionId] },
    });

    expect(refused.status).toBe(409);
    expect(at(refused.body, "error.details.reason")).toBe("prompt_required");
  });

  it("lets a parent batch-stop its own child, which the lineage rule permits", async () => {
    const harness = await bootWith(takesInjections);
    const parent = await liveSession(harness, takesInjections, { name: "A" });

    const childFixture = await command(harness, {
      lifecycle: "open",
      name: "Delegated",
    });
    const child = str(
      await run(harness, childFixture.commandId, takesInjections, {
        actor: `session:${parent.sessionId}`,
      }),
      "session.id",
    );

    const batch = await harness.ok("/batches", {
      method: "POST",
      body: {
        kind: "stop",
        batchKey: "stop-the-child",
        sessionIds: [child],
      },
      actor: `session:${parent.sessionId}`,
    });

    // Stopping takes capability away rather than authoring intent, so principle 1
    // does not refuse it — and a parent stopping its own runaway child is the most
    // useful batch stop there is (`authorsIntent`).
    expect(list(batch, "members")).toHaveLength(1);
    expect(at(batch, "members.0.ok")).toBe(true);
    await endedSession(harness, child);
  });
});
