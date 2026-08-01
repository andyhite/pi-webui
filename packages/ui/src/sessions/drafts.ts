/**
 * Drafts and prompt history, per session (spec §6.2): "an unsent message and
 * the recallable prompt history survive closing the panel and switching
 * away." Same shape as `placement/store.ts`'s durable-store seam — a small
 * async interface today's `localStorage` implementation satisfies, so a
 * server-side store (Phase 2+) swaps in without the Conversation panel
 * changing at all. Callers never touch storage directly.
 */

import type { StorageLike } from "../placement/store.js";

export interface SessionDraftsState {
  readonly draft: string;
  /** Newest first — recall walks from the most recently sent prompt. */
  readonly history: readonly string[];
}

export const EMPTY_DRAFTS_STATE: SessionDraftsState = {
  draft: "",
  history: [],
};

export interface SessionDraftsStore {
  load(sessionId: string): Promise<SessionDraftsState>;
  /** Called on every composer keystroke/blur — never touches history. */
  saveDraft(sessionId: string, draft: string): Promise<void>;
  /**
   * Called once a message is actually sent: clears the draft (it is no
   * longer unsent) and prepends it to history.
   */
  recordSent(sessionId: string, text: string): Promise<void>;
}

type DraftsBag = Readonly<Record<string, SessionDraftsState>>;

function isHistory(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isDraftsState(value: unknown): value is SessionDraftsState {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { draft: unknown }).draft === "string" &&
    isHistory((value as { history: unknown }).history)
  );
}

/** Parse stored JSON defensively: anything malformed yields an empty bag. */
export function parseDraftsBag(raw: string | null): DraftsBag {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const result: Record<string, SessionDraftsState> = {};
  for (const [sessionId, value] of Object.entries(parsed)) {
    if (isDraftsState(value)) result[sessionId] = value;
  }
  return result;
}

export function withDraft(
  bag: DraftsBag,
  sessionId: string,
  draft: string,
): DraftsBag {
  const current = bag[sessionId] ?? EMPTY_DRAFTS_STATE;
  return { ...bag, [sessionId]: { ...current, draft } };
}

export function withSentRecorded(
  bag: DraftsBag,
  sessionId: string,
  text: string,
): DraftsBag {
  const current = bag[sessionId] ?? EMPTY_DRAFTS_STATE;
  return {
    ...bag,
    [sessionId]: { draft: "", history: [text, ...current.history] },
  };
}

/** Store over Web Storage (localStorage until a server-side store exists). */
export function createWebStorageSessionDraftsStore(
  storage: StorageLike,
  key: string,
): SessionDraftsStore {
  function readBag(): DraftsBag {
    return parseDraftsBag(storage.getItem(key));
  }
  function writeBag(bag: DraftsBag): void {
    storage.setItem(key, JSON.stringify(bag));
  }

  return {
    load(sessionId): Promise<SessionDraftsState> {
      return Promise.resolve(readBag()[sessionId] ?? EMPTY_DRAFTS_STATE);
    },
    saveDraft(sessionId, draft): Promise<void> {
      writeBag(withDraft(readBag(), sessionId, draft));
      return Promise.resolve();
    },
    recordSent(sessionId, text): Promise<void> {
      writeBag(withSentRecorded(readBag(), sessionId, text));
      return Promise.resolve();
    },
  };
}

/** In-memory store for tests and fixture setups. */
export function createMemorySessionDraftsStore(
  initial: DraftsBag = {},
): SessionDraftsStore {
  let bag = initial;
  return {
    load(sessionId): Promise<SessionDraftsState> {
      return Promise.resolve(bag[sessionId] ?? EMPTY_DRAFTS_STATE);
    },
    saveDraft(sessionId, draft): Promise<void> {
      bag = withDraft(bag, sessionId, draft);
      return Promise.resolve();
    },
    recordSent(sessionId, text): Promise<void> {
      bag = withSentRecorded(bag, sessionId, text);
      return Promise.resolve();
    },
  };
}
