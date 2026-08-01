import type { NodeId } from "@plotroom/core";
import { describe, expect, it } from "vitest";

import { legalCreateMenuOptions } from "./create-menu.js";

describe("legalCreateMenuOptions", () => {
  it("offers only command targets when dragging from content", () => {
    const options = legalCreateMenuOptions({
      id: "ticket-1" as NodeId,
      role: "content",
    });
    expect(options.map((o) => o.kind)).toEqual(["command"]);
  });

  it("offers nothing when dragging from a command (not content)", () => {
    const options = legalCreateMenuOptions({
      id: "cmd-1" as NodeId,
      role: "command",
    });
    expect(options).toEqual([]);
  });

  it("offers nothing when dragging from a session (not content)", () => {
    const options = legalCreateMenuOptions({
      id: "sess-1" as NodeId,
      role: "session",
      running: true,
    });
    expect(options).toEqual([]);
  });

  it("respects a custom option list", () => {
    const options = legalCreateMenuOptions(
      { id: "ticket-1" as NodeId, role: "content" },
      [{ kind: "note", role: "content" }],
    );
    // content -> content is illegal, so the custom list yields nothing legal.
    expect(options).toEqual([]);
  });
});
