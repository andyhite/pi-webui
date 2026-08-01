import { describe, expect, it } from "vitest";
import { humanAuthor } from "@plotroom/core";

import {
  createFixtureAttentionDataSource,
  FIXTURE_ATTENTION_ITEMS,
} from "./data-source.js";

describe("createFixtureAttentionDataSource", () => {
  it("lists the fixture items ranked", async () => {
    const source = createFixtureAttentionDataSource(
      FIXTURE_ATTENTION_ITEMS,
      () => 0,
    );
    const items = await source.list();
    expect(items.map((i) => i.feed)).toEqual([
      "approval",
      "question",
      "drift",
      "health",
      "completion",
      "broadcast",
    ]);
  });

  it("mute removes the item from every later list/subscribe call", async () => {
    const source = createFixtureAttentionDataSource(
      FIXTURE_ATTENTION_ITEMS,
      () => 0,
    );
    await source.mute("attn-drift-1", { at: 0, by: humanAuthor });
    const items = await source.list();
    expect(items.find((i) => i.id === "attn-drift-1")).toBeUndefined();
  });

  it("snooze hides the item until the clock passes snoozedUntil, and carries snoozeUntil while hidden", async () => {
    let now = 0;
    const source = createFixtureAttentionDataSource(
      FIXTURE_ATTENTION_ITEMS,
      () => now,
    );
    await source.snooze("attn-health-1", {
      at: 0,
      by: humanAuthor,
      snoozedUntil: 100,
    });
    expect(
      (await source.list()).find((i) => i.id === "attn-health-1"),
    ).toBeUndefined();

    now = 100;
    const back = (await source.list()).find((i) => i.id === "attn-health-1");
    expect(back).toBeDefined();
    // NORMATIVE (`types.ts`): `snoozeUntil` reads `null` again the instant
    // an item returns — a stale non-null value here would be
    // indistinguishable from "still hidden".
    expect(back?.snoozeUntil).toBeNull();
  });

  it("answering a question acknowledges it \u2014 it leaves the queue", async () => {
    const source = createFixtureAttentionDataSource(
      FIXTURE_ATTENTION_ITEMS,
      () => 0,
    );
    await source.answerQuestion("attn-question-1", "opt-yes", {
      at: 0,
      by: humanAuthor,
    });
    expect(
      (await source.list()).find((i) => i.id === "attn-question-1"),
    ).toBeUndefined();
  });

  it("deciding an approval acknowledges it \u2014 it leaves the queue", async () => {
    const source = createFixtureAttentionDataSource(
      FIXTURE_ATTENTION_ITEMS,
      () => 0,
    );
    await source.decideApproval("attn-approval-1", "approve-once", {
      at: 0,
      by: humanAuthor,
    });
    expect(
      (await source.list()).find((i) => i.id === "attn-approval-1"),
    ).toBeUndefined();
  });

  it("a broadcast row carries {id, category, recipientCount} and answers only to triage", async () => {
    const source = createFixtureAttentionDataSource(
      FIXTURE_ATTENTION_ITEMS,
      () => 0,
    );
    const items = await source.list();
    const broadcast = items.find((i) => i.feed === "broadcast");
    expect(broadcast?.payload).toEqual({
      kind: "broadcast",
      broadcastId: "broadcast-1",
      category: "material-state-changed",
      recipientCount: 3,
    });

    await source.acknowledge(broadcast!.id, { at: 0, by: humanAuthor });
    expect(
      (await source.list()).find((i) => i.feed === "broadcast"),
    ).toBeUndefined();
  });

  it("a question row's options carry real ids, not just labels", async () => {
    const source = createFixtureAttentionDataSource(
      FIXTURE_ATTENTION_ITEMS,
      () => 0,
    );
    const question = (await source.list()).find(
      (i) => i.id === "attn-question-1",
    );
    expect(question?.payload).toMatchObject({
      kind: "question",
      options: [
        { id: "opt-yes", label: "yes" },
        { id: "opt-no", label: "no" },
        { id: "opt-later", label: "ask again later" },
      ],
    });
  });

  it("notifies subscribers on every triage gesture", async () => {
    const source = createFixtureAttentionDataSource(
      FIXTURE_ATTENTION_ITEMS,
      () => 0,
    );
    const seen: number[] = [];
    const unsubscribe = source.subscribe((items) => seen.push(items.length));
    await source.acknowledge("attn-completion-1", { at: 0, by: humanAuthor });
    expect(seen).toEqual([6, 5]);
    unsubscribe();
  });
});
