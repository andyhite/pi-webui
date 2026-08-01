import { describe, expect, it } from "vitest";

import {
  createMemorySessionDraftsStore,
  createWebStorageSessionDraftsStore,
  parseDraftsBag,
  withDraft,
  withSentRecorded,
} from "./drafts.js";
import type { StorageLike } from "../placement/store.js";

function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

describe("withDraft / withSentRecorded", () => {
  it("keeps a per-session draft independent of others", () => {
    let bag = withDraft({}, "sess-a", "hello");
    bag = withDraft(bag, "sess-b", "world");
    expect(bag["sess-a"]).toEqual({ draft: "hello", history: [] });
    expect(bag["sess-b"]).toEqual({ draft: "world", history: [] });
  });

  it("recording a sent message clears the draft and prepends history", () => {
    let bag = withDraft({}, "sess-a", "an unsent draft");
    bag = withSentRecorded(bag, "sess-a", "first prompt");
    expect(bag["sess-a"]).toEqual({
      draft: "",
      history: ["first prompt"],
    });
    bag = withDraft(bag, "sess-a", "typing the next one");
    bag = withSentRecorded(bag, "sess-a", "second prompt");
    expect(bag["sess-a"]).toEqual({
      draft: "",
      history: ["second prompt", "first prompt"],
    });
  });
});

describe("parseDraftsBag", () => {
  it("returns an empty bag for null, malformed json, or the wrong shape", () => {
    expect(parseDraftsBag(null)).toEqual({});
    expect(parseDraftsBag("{not json")).toEqual({});
    expect(parseDraftsBag("[]")).toEqual({});
    expect(
      parseDraftsBag(JSON.stringify({ a: { draft: 5, history: [] } })),
    ).toEqual({});
  });

  it("parses a valid bag", () => {
    const raw = JSON.stringify({ "sess-a": { draft: "hi", history: ["x"] } });
    expect(parseDraftsBag(raw)).toEqual({
      "sess-a": { draft: "hi", history: ["x"] },
    });
  });
});

describe("createWebStorageSessionDraftsStore", () => {
  it("survives a round trip through storage, per session", async () => {
    const storage = memoryStorage();
    const store = createWebStorageSessionDraftsStore(storage, "drafts-key");

    await store.saveDraft("sess-a", "unsent message");
    expect(await store.load("sess-a")).toEqual({
      draft: "unsent message",
      history: [],
    });

    // Surviving "closing the panel and switching away" (§6.2) is exactly a
    // fresh store instance reading the same underlying storage.
    const reopened = createWebStorageSessionDraftsStore(storage, "drafts-key");
    expect(await reopened.load("sess-a")).toEqual({
      draft: "unsent message",
      history: [],
    });
  });

  it("records sent prompts into recallable history, newest first", async () => {
    const store = createWebStorageSessionDraftsStore(memoryStorage(), "k");
    await store.recordSent("sess-a", "prompt one");
    await store.recordSent("sess-a", "prompt two");
    expect(await store.load("sess-a")).toEqual({
      draft: "",
      history: ["prompt two", "prompt one"],
    });
  });
});

describe("createMemorySessionDraftsStore", () => {
  it("behaves the same as the web-storage store, for tests", async () => {
    const store = createMemorySessionDraftsStore();
    await store.saveDraft("sess-a", "draft");
    await store.recordSent("sess-a", "sent");
    expect(await store.load("sess-a")).toEqual({
      draft: "",
      history: ["sent"],
    });
    expect(await store.load("sess-missing")).toEqual({
      draft: "",
      history: [],
    });
  });
});
