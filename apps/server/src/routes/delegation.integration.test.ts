import { afterEach, describe, expect, it } from "vitest";
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
  type Harness,
} from "../testing/harness.js";

/**
 * Delegation (§3.6, principle 5, Epic 4.5's server half).
 *
 * "There is exactly one way to start [a session], and it is in the app", so a
 * session dispatching a child is `POST /api/runs` with a session actor — not a
 * second verb, which is what principle 5 forbids. **What makes a run a delegation
 * is the actor**, and these tests are about the three things that follow: the
 * child is on the graph with its provenance, its spend is attributed up the
 * chain, and a run inside the caller's own chain is refused (§4.1).
 */
afterEach(cleanupHarnesses);

/** Streams one priced turn and ends, so there is spend to attribute. */
const priced = (costUsd: number): RuntimeScript => ({
  acts: [
    {
      on: "start",
      steps: [
        { observation: { kind: "turn-started", turn: 1 } },
        { observation: { kind: "output-delta", text: "done" } },
        {
          observation: {
            kind: "turn-ended",
            turn: 1,
            usage: { inputTokens: 10, outputTokens: 4, costUsd },
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
});

const staysOpen: RuntimeScript = {
  acts: [
    {
      on: "start",
      steps: [
        { observation: { kind: "turn-started", turn: 1 } },
        {
          observation: {
            kind: "turn-ended",
            turn: 1,
            usage: { inputTokens: 5, outputTokens: 1, costUsd: 0.004 },
          },
        },
      ],
    },
  ],
};

async function edges(harness: Harness): Promise<unknown[]> {
  return list(await harness.ok("/snapshot"), "edges");
}

describe("a session actor makes a run a delegation (§3.6)", () => {
  it("records the child on the graph with `session_delegated` provenance", async () => {
    const harness = await boot(repository());

    // The parent: a human's gesture, which is where every chain terminates.
    const parentFixture = await command(harness, { lifecycle: "open" });
    const parent = str(
      await run(harness, parentFixture.commandId, staysOpen),
      "session.id",
    );

    // The child: the same endpoint, a session actor. Nothing else changes.
    const childFixture = await command(harness, {
      lifecycle: "open",
      name: "Delegated work",
    });
    const child = str(
      await run(harness, childFixture.commandId, priced(0.01), {
        actor: `session:${parent}`,
      }),
      "session.id",
    );

    const delegated = (await edges(harness)).filter(
      (edge) => at(edge, "relation") === "session_delegated",
    );
    expect(delegated).toHaveLength(1);

    // Provenance, never authored (§3.7): the parent did not decide what the
    // child knows by dispatching it, so the edge carries a relation and no
    // author at all — the wire shape has nowhere to put one.
    expect(at(delegated[0], "kind")).toBe("provenance");
    expect(at(delegated[0], "author")).toBeUndefined();

    // The child is a session node on the board — "there is never an invisible
    // session" (principle 5).
    const nodes = list(await harness.ok("/snapshot"), "nodes");
    expect(
      nodes.filter(
        (node) => at(node, "role") === "session" && at(node, "refId") === child,
      ),
    ).toHaveLength(1);
  });

  it("attributes the child's spend up the initiating chain (principle 2)", async () => {
    const harness = await boot(repository());
    const parentFixture = await command(harness, { lifecycle: "open" });
    const parent = str(
      await run(harness, parentFixture.commandId, staysOpen),
      "session.id",
    );

    const childFixture = await command(harness, {
      lifecycle: "open",
      name: "Delegated work",
    });
    const child = str(
      await run(harness, childFixture.commandId, priced(0.01), {
        actor: `session:${parent}`,
      }),
      "session.id",
    );
    await endedSession(harness, child);

    // The spender's own row.
    const childSpend = await harness.ok(`/sessions/${child}/spend`);
    expect(at(childSpend, "attributedMicros")).toBe(10_000);
    expect(list(childSpend, "entries")).toHaveLength(1);
    expect(at(childSpend, "entries.0.basis")).toBe("own");

    // And the parent's, charged for what its delegate spent — the whole point:
    // "its spend counts against every budget that binds the initiating work."
    const parentSpend = await harness.ok(`/sessions/${parent}/spend`);
    const entries = list(parentSpend, "entries");
    expect(entries.map((entry) => at(entry, "basis"))).toContain("descendant");
    expect(
      entries.find((entry) => at(entry, "sourceSessionId") === child),
    ).toBeDefined();

    // Recorded in micros, formatted beside it rather than instead of it.
    expect(at(parentSpend, "attributed")).toMatch(/^\$/);

    // The fleet total counts each spender once, not once per ancestor.
    const fleet = await harness.ok("/spend");
    expect(at(fleet, "spentMicros")).toBe(10_000);
  });

  it("charges a doubled attribution once (principle 9, applied to money)", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, { lifecycle: "open" });
    const sessionId = str(
      await run(harness, fixture.commandId, priced(0.02)),
      "session.id",
    );
    await endedSession(harness, sessionId);

    // Ending is idempotent (the first outcome wins), and so is the attribution
    // it triggers: the accounting total is folded from the log, so a second
    // attribution replaces the row rather than adding to it.
    await harness.call(`/sessions/${sessionId}/stop`, {
      method: "POST",
      body: {},
    });

    const spend = await harness.ok(`/sessions/${sessionId}/spend`);
    expect(at(spend, "attributedMicros")).toBe(20_000);
    expect(list(spend, "entries")).toHaveLength(1);
  });
});

describe("§4.1's lineage rule", () => {
  it("refuses a session running work inside its own initiation chain", async () => {
    const harness = await boot(repository());
    const fixture = await command(harness, { lifecycle: "open" });

    // The command has already run, so the sessions it reaches include this one.
    const sessionId = str(
      await run(harness, fixture.commandId, staysOpen),
      "session.id",
    );

    const rerun = await harness.call("/runs", {
      method: "POST",
      body: {
        commandId: fixture.commandId,
        initiationKey: "own-chain-attempt",
        runtime: { script: staysOpen },
      },
      actor: `session:${sessionId}`,
    });

    expect(rerun.status).toBe(409);
    expect(at(rerun.body, "error.details.reason")).toBe("own_chain");

    // Refused *before* anything was recorded: the gesture produced no run, and
    // its initiation key is free again rather than permanently spent.
    const retried = await harness.call("/runs", {
      method: "POST",
      body: {
        commandId: fixture.commandId,
        initiationKey: "own-chain-attempt",
        runtime: { script: staysOpen },
      },
    });
    expect(retried.status).toBe(201);
  });

  it("permits a delegation, which is a descendant by construction", async () => {
    const harness = await boot(repository());
    const parentFixture = await command(harness, { lifecycle: "open" });
    const parent = str(
      await run(harness, parentFixture.commandId, staysOpen),
      "session.id",
    );

    // A command the parent has never run: nothing it reaches is in the chain, so
    // dispatching it is the delegation §3.6 exists to allow. Resolving the target
    // to the session about to be created would refuse this, which is why the
    // catalog's contract says NEVER in capitals.
    const childFixture = await command(harness, {
      lifecycle: "open",
      name: "Delegated work",
    });
    const dispatched = await harness.call("/runs", {
      method: "POST",
      body: {
        commandId: childFixture.commandId,
        initiationKey: "delegation-1",
        runtime: { script: staysOpen },
      },
      actor: `session:${parent}`,
    });

    expect(dispatched.status).toBe(201);
  });
});
