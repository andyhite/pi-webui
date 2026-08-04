/**
 * The attention queue's cursor (§7.1, §11): the ranked list, which row is
 * highlighted, and every verb that acts on it — move, navigate, answer,
 * approve, deny, acknowledge, snooze, mute.
 *
 * It lives here, at the host, rather than inside `QueuePanel`, for one
 * reason: §11 asks for **keyboard access to the verbs** — "move through the
 * queue, answer the selected item" — and a cursor owned by the panel would
 * only exist while the panel happened to be open. One cursor, held by the
 * app, is what lets the keyboard bindings and the panel's own buttons be the
 * same act on the same selection (principle 8) instead of two.
 *
 * Ranking and traversal stay in `queue.ts`'s pure functions; this only holds
 * the subscription and the cursor.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { moveQueueSelection, rankAttentionItems } from "./queue.js";
import type {
  AttentionDataSource,
  AttentionItem,
  TriageActionInput,
} from "./types.js";

/** An hour: "bring it back later" (§4.5), not gone forever. */
export const DEFAULT_SNOOZE_SECONDS = 60 * 60;

export interface AttentionQueueCursor {
  /** Ranked, exactly as the panel renders them (`rankAttentionItems`). */
  readonly items: readonly AttentionItem[];
  readonly selectedId: string | null;
  readonly selected: AttentionItem | null;
  /** Highlights a row without navigating — the keyboard's j/k. */
  readonly move: (direction: "next" | "prev") => void;
  /** Highlights a row by id (a click on it). */
  readonly highlight: (itemId: string) => void;
  /**
   * Selection-as-route (§5): moves the canvas to the row's target and
   * highlights it. The queue is a lens, not a place.
   */
  readonly navigate: (itemId?: string) => void;
  /**
   * Answers a `question` row with its Nth option (0-based). Returns false
   * when the row is not a question or has no such option — the caller
   * reports that honestly rather than pretending a key did something.
   */
  readonly answerOption: (index: number, itemId?: string) => boolean;
  /** Answers a `question` row with a specific option id. */
  readonly answer: (optionId: string, itemId?: string) => boolean;
  /** Approves an `approval` row once (§6.6). */
  readonly approve: (itemId?: string) => boolean;
  /**
   * Denies an `approval` row. A deny with no reason is refused server-side
   * (§6.6: "declining is feedback... never a bare refusal"), so an empty
   * reason returns false here rather than sending one.
   */
  readonly deny: (reason: string, itemId?: string) => boolean;
  /**
   * The deny reason typed for a row, and the setter for it. Held here rather
   * than in the panel because the `d` binding has to read the same draft the
   * row's own deny button does — one selection, one draft, one act.
   */
  readonly denyReason: (itemId: string) => string;
  readonly setDenyReason: (itemId: string, reason: string) => void;
  /** Denies the highlighted row with whatever reason is currently typed for it. */
  readonly denySelected: () => boolean;
  readonly acknowledge: (itemId?: string) => boolean;
  readonly snooze: (itemId?: string, snoozeSeconds?: number) => boolean;
  readonly mute: (itemId?: string) => boolean;
}

export interface UseAttentionQueueCursorOptions {
  readonly dataSource: AttentionDataSource;
  /** The host's `select()` — the one navigation primitive (§5). */
  readonly onNavigate: (nodeId: string) => void;
  /** Injectable so triage timestamps are testable without a real clock. */
  readonly now?: () => number;
  readonly triageAuthor?: TriageActionInput["by"];
}

export function useAttentionQueueCursor({
  dataSource,
  onNavigate,
  now = () => Math.floor(Date.now() / 1000),
  triageAuthor,
}: UseAttentionQueueCursorOptions): AttentionQueueCursor {
  const [items, setItems] = useState<readonly AttentionItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // A deny needs a reason (§6.6) — typed per row, keyed by item id, so several
  // approval rows never clobber each other's draft.
  const [denyReasons, setDenyReasons] = useState<Record<string, string>>({});

  useEffect(() => {
    return dataSource.subscribe((next) => {
      setItems(next);
      // Keep the highlight on the row it was on; fall back to the top row
      // when that row left the queue (answered, snoozed, muted).
      setSelectedId((current) =>
        current !== null && next.some((item) => item.id === current)
          ? current
          : (rankAttentionItems(next)[0]?.id ?? null),
      );
    });
  }, [dataSource]);

  // A data source is expected to have applied triage before emitting
  // (`types.ts`'s NORMATIVE rule: hiding a muted or currently-snoozed item is
  // the source's job) — this only ranks what it was given.
  const ranked = useMemo(() => rankAttentionItems(items), [items]);

  const resolve = useCallback(
    (itemId?: string): AttentionItem | null => {
      const id = itemId ?? selectedId;
      if (id === null || id === undefined) return null;
      return ranked.find((item) => item.id === id) ?? null;
    },
    [ranked, selectedId],
  );

  const triageInput = useCallback(
    (): TriageActionInput => ({
      at: now(),
      by: triageAuthor ?? { kind: "human" },
    }),
    [now, triageAuthor],
  );

  return useMemo<AttentionQueueCursor>(() => {
    function withItem(
      itemId: string | undefined,
      act: (item: AttentionItem) => void,
    ): boolean {
      const item = resolve(itemId);
      if (!item) return false;
      act(item);
      return true;
    }

    /** One deny path, called by the row's button, `deny`, and `denySelected`. */
    function denyWith(reason: string, itemId?: string): boolean {
      const trimmed = reason.trim();
      if (trimmed === "") return false;
      return withItem(itemId, (item) => {
        if (item.payload.kind !== "approval") return;
        void dataSource.decideApproval(item.id, "deny", triageInput(), trimmed);
      });
    }

    return {
      items: ranked,
      selectedId,
      selected: resolve(),
      move(direction) {
        setSelectedId((current) =>
          moveQueueSelection(ranked, current, direction),
        );
      },
      highlight(itemId) {
        setSelectedId(itemId);
      },
      navigate(itemId) {
        const item = resolve(itemId);
        if (!item) return;
        setSelectedId(item.id);
        onNavigate(item.target.nodeId);
      },
      answerOption(index, itemId) {
        return withItem(itemId, (item) => {
          if (item.payload.kind !== "question") return;
          const option = item.payload.options[index];
          if (!option) return;
          void dataSource.answerQuestion(item.id, option.id, triageInput());
        });
      },
      answer(optionId, itemId) {
        return withItem(itemId, (item) => {
          if (item.payload.kind !== "question") return;
          void dataSource.answerQuestion(item.id, optionId, triageInput());
        });
      },
      approve(itemId) {
        return withItem(itemId, (item) => {
          if (item.payload.kind !== "approval") return;
          void dataSource.decideApproval(
            item.id,
            "approve-once",
            triageInput(),
          );
        });
      },
      deny: denyWith,
      denyReason(itemId) {
        return denyReasons[itemId] ?? "";
      },
      setDenyReason(itemId, reason) {
        setDenyReasons((current) => ({ ...current, [itemId]: reason }));
      },
      denySelected() {
        if (selectedId === null) return false;
        return denyWith(denyReasons[selectedId] ?? "", selectedId);
      },
      acknowledge(itemId) {
        return withItem(itemId, (item) => {
          void dataSource.acknowledge(item.id, triageInput());
        });
      },
      snooze(itemId, snoozeSeconds = DEFAULT_SNOOZE_SECONDS) {
        return withItem(itemId, (item) => {
          void dataSource.snooze(item.id, {
            ...triageInput(),
            snoozedUntil: now() + snoozeSeconds,
          });
        });
      },
      mute(itemId) {
        return withItem(itemId, (item) => {
          void dataSource.mute(item.id, triageInput());
        });
      },
    };
  }, [
    dataSource,
    denyReasons,
    now,
    onNavigate,
    ranked,
    resolve,
    selectedId,
    triageInput,
  ]);
}
