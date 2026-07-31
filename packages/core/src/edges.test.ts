import { describe, expect, it } from "vitest";
import { checkConnection, wouldCycle, type GraphNode } from "./edges.js";
import { checkAuthoring, isInSameChain, ancestorsOf } from "./lineage.js";
import { humanAuthor, sessionAuthor } from "./author.js";
import type { NodeId, SessionId } from "./ids.js";

const content = (id = "n_content"): GraphNode => ({
  id: id as NodeId,
  role: "content",
});
const command = (id = "n_command"): GraphNode => ({
  id: id as NodeId,
  role: "command",
});
const session = (running: boolean, id = "n_session"): GraphNode => ({
  id: id as NodeId,
  role: "session",
  running,
});

describe("the legal connections, exhaustively (spec §3.7)", () => {
  it("allows content into a command", () => {
    expect(checkConnection(content(), command()).legal).toBe(true);
  });

  it("allows content into a running session", () => {
    expect(checkConnection(content(), session(true)).legal).toBe(true);
  });

  it("refuses content into an ended session", () => {
    const check = checkConnection(content(), session(false));
    expect(check).toMatchObject({
      legal: false,
      refusal: { reason: "session_not_running" },
    });
  });

  it("refuses content into content", () => {
    expect(checkConnection(content("a"), content("b"))).toMatchObject({
      legal: false,
      refusal: { reason: "illegal_target" },
    });
  });

  it("refuses a command as a source", () => {
    expect(checkConnection(command("a"), command("b"))).toMatchObject({
      legal: false,
      refusal: { reason: "source_not_content" },
    });
  });

  it("refuses a session as a source", () => {
    expect(checkConnection(session(true, "a"), command())).toMatchObject({
      legal: false,
      refusal: { reason: "source_not_content" },
    });
  });

  it("refuses a self-connection", () => {
    expect(checkConnection(content("same"), content("same"))).toMatchObject({
      legal: false,
      refusal: { reason: "self" },
    });
  });
});

describe("command-topology acyclicity (spec §3.7)", () => {
  const a = "cmd_a" as NodeId;
  const b = "cmd_b" as NodeId;
  const c = "cmd_c" as NodeId;

  it("detects a direct cycle", () => {
    // a already consumes b's output; wiring a's output into b closes the loop.
    expect(wouldCycle(new Map([[a, [b]]]), a, b)).toBe(true);
  });

  it("allows the wire that already exists to be re-derived", () => {
    // b feeding a again is not a cycle: a consumes b, not the reverse.
    expect(wouldCycle(new Map([[a, [b]]]), b, a)).toBe(false);
  });

  it("detects a transitive cycle", () => {
    const inputs = new Map<NodeId, NodeId[]>([
      [b, [a]],
      [c, [b]],
    ]);
    expect(wouldCycle(inputs, c, a)).toBe(true);
  });

  it("allows a diamond", () => {
    const inputs = new Map<NodeId, NodeId[]>([
      [b, [a]],
      [c, [a]],
    ]);
    expect(wouldCycle(inputs, b, c)).toBe(false);
  });

  it("treats a command feeding itself as a cycle", () => {
    expect(wouldCycle(new Map(), a, a)).toBe(true);
  });
});

describe("no agent authors intent into its own chain (principle 1)", () => {
  //  human → root → child → grandchild,  and an unrelated peer
  const chain = new Map<string, string | null>([
    ["root", null],
    ["child", "root"],
    ["grandchild", "child"],
    ["peer", null],
  ]);

  const index = {
    parentOf: (s: SessionId) => (chain.get(s) ?? null) as SessionId | null,
  };

  const s = (id: string) => id as SessionId;

  it("walks the chain up to the human gesture", () => {
    expect(ancestorsOf(index, s("grandchild"))).toEqual(["child", "root"]);
    expect(ancestorsOf(index, s("root"))).toEqual([]);
  });

  it("refuses a session authoring into itself", () => {
    expect(
      checkAuthoring(index, sessionAuthor(s("child")), s("child")),
    ).toMatchObject({ allowed: false, refusal: { reason: "own_chain" } });
  });

  it("refuses authoring into an ancestor", () => {
    expect(
      checkAuthoring(index, sessionAuthor(s("grandchild")), s("root")),
    ).toMatchObject({ allowed: false });
  });

  it("refuses authoring into a descendant", () => {
    expect(
      checkAuthoring(index, sessionAuthor(s("root")), s("grandchild")),
    ).toMatchObject({ allowed: false });
  });

  it("allows sessions outside each other's chains to collaborate", () => {
    expect(
      checkAuthoring(index, sessionAuthor(s("peer")), s("grandchild")).allowed,
    ).toBe(true);
    expect(isInSameChain(index, s("peer"), s("child"))).toBe(false);
  });

  it("leaves humans unconstrained", () => {
    expect(checkAuthoring(index, humanAuthor, s("root")).allowed).toBe(true);
  });

  it("allows a session to author into a command (no target session)", () => {
    expect(checkAuthoring(index, sessionAuthor(s("child")), null).allowed).toBe(
      true,
    );
  });
});
