import { expect, describe, it } from "bun:test";
import { parseActor } from "./actor.js";

describe("attribution: who is making this call (§15 invariant 2)", () => {
  it("defaults to the human operator when the header is absent", () => {
    expect(parseActor(undefined)).toEqual({
      ok: true,
      actor: { kind: "human" },
    });
    expect(parseActor("")).toEqual({ ok: true, actor: { kind: "human" } });
    expect(parseActor("human")).toEqual({ ok: true, actor: { kind: "human" } });
  });

  it("reads a session actor, which is what makes an edge's author real", () => {
    expect(parseActor("session:sess_42") as unknown).toEqual({
      ok: true,
      actor: { kind: "session", sessionId: "sess_42" },
    });
    expect(parseActor("  session:sess_42  ") as unknown).toEqual({
      ok: true,
      actor: { kind: "session", sessionId: "sess_42" },
    });
  });

  it("refuses an actor it cannot parse rather than falling back to human", () => {
    for (const header of ["robot", "session", "session:", "session:   "]) {
      const result = parseActor(header);
      expect(result.ok).toBe(false);
    }
  });
});
