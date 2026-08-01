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
  });

  it("answering a question acknowledges it \u2014 it leaves the queue", async () => {
    const source = createFixtureAttentionDataSource(
      FIXTURE_ATTENTION_ITEMS,
      () => 0,
    );
    await source.answerQuestion("attn-question-1", "yes", {
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
    await source.decideApproval("attn-approval-1", "approve", {
      at: 0,
      by: humanAuthor,
    });
    expect(
      (await source.list()).find((i) => i.id === "attn-approval-1"),
    ).toBeUndefined();
  });

  it("notifies subscribers on every triage gesture", async () => {
    const source = createFixtureAttentionDataSource(
      FIXTURE_ATTENTION_ITEMS,
      () => 0,
    );
    const seen: number[] = [];
    const unsubscribe = source.subscribe((items) => seen.push(items.length));
    await source.acknowledge("attn-completion-1", { at: 0, by: humanAuthor });
    expect(seen).toEqual([5, 4]);
    unsubscribe();
  });
});
