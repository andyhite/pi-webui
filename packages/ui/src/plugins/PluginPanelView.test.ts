import { describe, expect, it } from "vitest";
import type { draft } from "@plotroom/plugin-sdk";

import { resolvePluginPanelViewState } from "./PluginPanelView.js";

function draftPanel(render: draft.DraftPanel["render"]): draft.DraftPanel {
  return { id: "plugins", title: "a plugin panel", placement: "right", render };
}

describe("resolvePluginPanelViewState", () => {
  it("resolves 'ready' with the rendered view when render() succeeds", async () => {
    const view: draft.DraftCardView = { title: "x", lines: ["a"], actions: [] };
    const state = await resolvePluginPanelViewState(
      draftPanel(async () => view),
    );
    expect(state).toEqual({ kind: "ready", view });
  });

  it("degrades to 'failed' with the Error's message when render() rejects \u2014 never a crashed dock rail (\u00a710.2)", async () => {
    const state = await resolvePluginPanelViewState(
      draftPanel(async () => {
        throw new Error("boom");
      }),
    );
    expect(state).toEqual({ kind: "failed", reason: "boom" });
  });

  it("degrades to 'failed' with a coerced reason when render() rejects with a non-Error value", async () => {
    const state = await resolvePluginPanelViewState(
      draftPanel(() => Promise.reject("not an error")),
    );
    expect(state).toEqual({ kind: "failed", reason: "not an error" });
  });
});
