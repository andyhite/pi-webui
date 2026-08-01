import { describe, expect, it } from "vitest";

import { humanAuthor, sessionAuthor } from "../author.js";
import { newNodeId, newSessionId, type SessionId } from "../ids.js";
import type { LineageIndex } from "../lineage.js";
import {
  EMPTY_INJECTIONS,
  checkInjection,
  deliveryDelay,
  injectionStatus,
  markDelivered,
  markRefused,
  queueInjection,
  queuedInjections,
} from "./injection.js";
import { endSession } from "./session.js";
import { makeSession } from "./testing.js";

const node = newNodeId();

function ledgerWithOne(sessionId: SessionId) {
  return queueInjection(EMPTY_INJECTIONS, {
    id: "inj-1",
    sessionId,
    author: humanAuthor,
    nodeId: node,
    text: "stop grepping; the answer is in docs/architecture.md",
    queuedAt: 1_000,
  });
}

describe("the injection ledger (§6.5)", () => {
  it("records queue acceptance, not delivery", () => {
    const session = makeSession();
    const ledger = ledgerWithOne(session.id);
    const entry = ledger.get("inj-1");

    expect(entry && injectionStatus(entry)).toBe("queued");
    expect(entry?.deliveredAt).toBeNull();
    expect(queuedInjections(ledger, session.id)).toHaveLength(1);
  });

  it("moves to delivered only when delivery is observed", () => {
    const session = makeSession();
    const delivered = markDelivered(ledgerWithOne(session.id), "inj-1", 1_090);
    const entry = delivered.get("inj-1");

    expect(entry && injectionStatus(entry)).toBe("delivered");
    // The ninety seconds §6.5 is written about.
    expect(entry && deliveryDelay(entry)).toBe(90);
    expect(queuedInjections(delivered)).toHaveLength(0);
  });

  it("keeps the author and the graph node on every entry (principle 1, 5)", () => {
    const entry = ledgerWithOne(makeSession().id).get("inj-1");

    expect(entry?.author).toEqual(humanAuthor);
    expect(entry?.nodeId).toBe(node);
  });

  it("records one entry per gesture, however many times it is retried (principle 9)", () => {
    const session = makeSession();
    const once = ledgerWithOne(session.id);
    const twice = queueInjection(once, {
      id: "inj-1",
      sessionId: session.id,
      author: humanAuthor,
      nodeId: node,
      text: "different text, same gesture",
      queuedAt: 2_000,
    });

    expect(twice.size).toBe(1);
    expect(twice.get("inj-1")?.queuedAt).toBe(1_000);
  });

  it("does not un-deliver a delivered injection", () => {
    const session = makeSession();
    const delivered = markDelivered(ledgerWithOne(session.id), "inj-1", 1_090);
    const refused = markRefused(delivered, "inj-1", 1_200, "too late");

    expect(refused.get("inj-1")?.refusedAt).toBeNull();
  });

  it("records an injection the runtime never took", () => {
    const session = makeSession();
    const refused = markRefused(
      ledgerWithOne(session.id),
      "inj-1",
      1_200,
      "the session ended first",
    );
    const entry = refused.get("inj-1");

    expect(entry && injectionStatus(entry)).toBe("refused");
    expect(entry?.refusedReason).toBe("the session ended first");
  });
});

describe("who may inject", () => {
  const parent = newSessionId();

  it("refuses an ended session (§3.7)", () => {
    const index: LineageIndex = { parentOf: () => null };
    const ended = endSession(makeSession(), {
      kind: "ended-by-user",
      at: 5_000,
    });

    const check = checkInjection(index, humanAuthor, ended);

    expect(check).toEqual({
      allowed: false,
      refusal: {
        reason: "session_not_running",
        message: "that session has ended; fork or re-run it instead",
      },
    });
  });

  it("refuses a session injecting into its own chain (principle 1)", () => {
    const child = makeSession();
    const index: LineageIndex = {
      parentOf: (session) => (session === child.id ? parent : null),
    };

    const check = checkInjection(index, sessionAuthor(parent), child);

    expect(check.allowed).toBe(false);
    expect(check.allowed === false && check.refusal.reason).toBe("own_chain");
  });

  it("allows peers outside each other's chains, and humans anywhere", () => {
    const target = makeSession();
    const index: LineageIndex = { parentOf: () => null };

    expect(checkInjection(index, humanAuthor, target)).toEqual({
      allowed: true,
    });
    expect(
      checkInjection(index, sessionAuthor(newSessionId()), target),
    ).toEqual({ allowed: true });
  });
});
