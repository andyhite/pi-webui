import { describe, expect, it } from "vitest";
import { formatOutputAddress } from "./output-address.js";
import { humanAuthor, sessionAuthor } from "./author.js";
import type { CommandId, RunId, SessionId } from "./ids.js";

const commandId = "cmd_1" as CommandId;
const runId = "run_7" as RunId;

describe("output addressing (spec §15 invariant 4)", () => {
  it("addresses latest as one case, not the only case", () => {
    expect(formatOutputAddress({ commandId, name: "plan", at: "latest" })).toBe(
      "cmd_1/plan@latest",
    );
  });

  it("addresses output@n, the general case latest is a case of", () => {
    expect(
      formatOutputAddress({
        commandId,
        name: "plan",
        at: "ordinal",
        runOrdinal: 3,
      }),
    ).toBe("cmd_1/plan@3");
  });

  it("addresses a specific run", () => {
    expect(
      formatOutputAddress({ commandId, name: "plan", at: "run", runId }),
    ).toBe("cmd_1/plan@run_7");
  });

  it("addresses a pinned run", () => {
    expect(
      formatOutputAddress({ commandId, name: "plan", at: "pinned", runId }),
    ).toBe("cmd_1/plan@run_7");
  });
});

describe("edge authorship (spec §15 invariant 2)", () => {
  it("distinguishes human from session authors", () => {
    expect(humanAuthor.kind).toBe("human");
    expect(sessionAuthor("sess_2" as SessionId)).toEqual({
      kind: "session",
      sessionId: "sess_2",
    });
  });
});
