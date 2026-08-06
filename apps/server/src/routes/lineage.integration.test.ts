import { expect, afterEach, describe, it } from "bun:test";
import type { RuntimeScript } from "../runtime/scripted.js";
import {
  at,
  boot,
  cleanupHarnesses,
  command,
  list,
  repository,
  run,
  str,
  type Harness,
} from "../testing/harness.js";

/**
 * Principle 1 on the session-authored HTTP path (§4.1, issue #75).
 *
 * `@plotroom/core` proves the rule (`checkToolCall` refuses `own_chain`); what is
 * proved here is that the rule is **reached over HTTP** for the three single-session
 * verbs that used to declare it and bind nothing — and, the reported bug, that a
 * pre-granted destruction cannot reach the granting session's own chain, because a
 * pre-grant matches by tool and never by target.
 *
 * The pair of directions matters equally: a guard that refused a *peer* session's
 * deletion would have broken §6.6's whole channel, so every refusal below is matched
 * by the same call against a session outside the chain, still going through
 * approvals.
 */
afterEach(cleanupHarnesses);

/** A session that stays live, so it can still make calls of its own. */
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
            usage: { inputTokens: 6, outputTokens: 2, costUsd: 0.001 },
          },
        },
      ],
    },
  ],
};

interface Chain {
  readonly parent: string;
  readonly child: string;
  /** A session in nobody's chain: started by the operator, like the parent. */
  readonly peer: string;
}

/**
 * A parent that delegated a child, plus an unrelated session. Delegation is what
 * makes a lineage at all — the same endpoint with a session actor (§3.6).
 */
async function chain(harness: Harness): Promise<Chain> {
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
    await run(harness, childFixture.commandId, staysOpen, {
      actor: `session:${parent}`,
    }),
    "session.id",
  );

  const peerFixture = await command(harness, {
    lifecycle: "open",
    name: "Somebody else's work",
  });
  const peer = str(
    await run(harness, peerFixture.commandId, staysOpen),
    "session.id",
  );

  return { parent, child, peer };
}

async function pendingApprovals(harness: Harness): Promise<unknown[]> {
  return list(await harness.ok("/approvals"), "approvals");
}

describe("a session's verbs against its own chain (§4.1, principle 1)", () => {
  it("refuses stop, end, and delete up its own chain, and executes none of them", async () => {
    const harness = await boot(repository());
    const { parent, child } = await chain(harness);

    for (const path of [
      `/sessions/${parent}/stop`,
      `/sessions/${parent}/end`,
    ]) {
      const attempt = await harness.call(path, {
        method: "POST",
        actor: `session:${child}`,
      });
      // 409 and the predicate's own reason: the request was understood and the
      // rules said no. Same reason string the canvas shows (principle 8).
      expect(attempt.status, path).toBe(409);
      expect(at(attempt.body, "error.details.reason"), path).toBe("own_chain");
    }

    const deletion = await harness.call(`/sessions/${parent}`, {
      method: "DELETE",
      actor: `session:${child}`,
    });
    expect(deletion.status).toBe(409);
    expect(at(deletion.body, "error.details.reason")).toBe("own_chain");

    // Nothing happened to the parent: still open, still on the board. A refusal
    // that had let the stop through would read the same from the response alone.
    const read = await harness.ok(`/sessions/${parent}`);
    expect(at(read, "session.end")).toBeNull();
    expect(at(read, "session.deletion.deletedAt")).toBeNull();

    // And it is a refusal, not an approval: nobody was asked about it.
    expect(await pendingApprovals(harness)).toHaveLength(0);
  });

  it("refuses down its own chain too, not only up it", async () => {
    const harness = await boot(repository());
    const { parent, child } = await chain(harness);

    // `isInSameChain` is symmetric, and this is the direction most likely to
    // surprise: a parent may not single-stop the child it delegated either. The
    // batch envelope is where that gesture lives (`authorsIntent`, §4.2).
    const attempt = await harness.call(`/sessions/${child}/stop`, {
      method: "POST",
      body: {},
      actor: `session:${parent}`,
    });
    expect(attempt.status).toBe(409);
    expect(at(attempt.body, "error.details.reason")).toBe("own_chain");
  });

  it("refuses a session taking itself off the board", async () => {
    const harness = await boot(repository());
    const { parent } = await chain(harness);

    const attempt = await harness.call(`/sessions/${parent}`, {
      method: "DELETE",
      actor: `session:${parent}`,
    });
    expect(attempt.status).toBe(409);
    expect(at(attempt.body, "error.details.reason")).toBe("own_chain");
  });

  it("still lets the operator do all three, whoever's chain they are in", async () => {
    const harness = await boot(repository());
    const { parent, child, peer } = await chain(harness);

    // The human actor is unconstrained — the authority every chain terminates at.
    // This is what makes the refusals above a rule about sessions rather than a
    // capability the product lost, so all three verbs are driven, not two.
    await harness.ok(`/sessions/${child}/stop`, { method: "POST", body: {} });
    await harness.ok(`/sessions/${peer}/end`, { method: "POST" });
    const deleted = await harness.ok(`/sessions/${parent}`, {
      method: "DELETE",
    });
    expect(at(deleted, "restorable")).toBe(true);
  });

  it("leaves a peer's deletion to §6.6, which is what it is for", async () => {
    const harness = await boot(repository());
    const { child, peer } = await chain(harness);

    const attempt = await harness.call(`/sessions/${peer}`, {
      method: "DELETE",
      actor: `session:${child}`,
    });
    // 202: accepted and waiting on a person. The lineage guard let it past, and
    // the destruction guard raised the approval.
    expect(attempt.status).toBe(202);
    expect(at(attempt.body, "executed")).toBe(false);
    expect(await pendingApprovals(harness)).toHaveLength(1);
  });
});

describe("a pre-granted destruction and the granting chain (§6.6, issue #75)", () => {
  it("does not cover the caller's own chain, however wide the pattern", async () => {
    const harness = await boot(repository());
    const { parent, child, peer } = await chain(harness);

    // The operator's own standing decision over the calling session, as wide as one
    // can be written: every destruction, every tool. It is matched by kind and tool
    // pattern and never by target, which is exactly why principle 1 has to be
    // settled before it.
    await harness.ok("/pre-grants", {
      method: "POST",
      body: {
        scope: { kind: "session", sessionId: child },
        effect: "allow",
        kinds: ["destruction"],
        toolPattern: "**",
        extents: ["none", "paths", "unbounded"],
      },
    });

    const ownChain = await harness.call(`/sessions/${parent}`, {
      method: "DELETE",
      actor: `session:${child}`,
    });
    expect(ownChain.status).toBe(409);
    expect(at(ownChain.body, "error.details.reason")).toBe("own_chain");
    expect(at(await harness.ok(`/sessions/${parent}`), "session.id")).toBe(
      parent,
    );

    // The same pre-grant still does its job outside the chain: covered, executed,
    // and nobody asked. Without this the fix would just be a broken pre-grant.
    const covered = await harness.call(`/sessions/${peer}`, {
      method: "DELETE",
      actor: `session:${child}`,
    });
    expect(covered.status).toBe(200);
    expect(await pendingApprovals(harness)).toHaveLength(0);
  });
});
