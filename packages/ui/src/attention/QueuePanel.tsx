/**
 * The attention queue (§7.1, §11): "a single ranked list of everything
 * wanting a decision, keyboard-driven, where each row carries enough
 * context to answer without opening anything." Selecting a row navigates
 * the canvas through the exact same selection-as-route primitive every
 * other entry point uses (§5) — the queue is a lens, not a place, so it
 * never keeps its own idea of "where you are" beyond which row is
 * highlighted.
 *
 * In-place answers reuse the same shape the bubble layer already answers
 * questions with (`BubbleLayer.tsx`'s option buttons) rather than a second
 * question-answering widget: a `question` row renders its options as real
 * buttons, an `approval` row renders approve/deny, and every row — those
 * two included, per §7.1's "every feed supports acknowledge, snooze, and
 * mute" — carries the three triage verbs.
 *
 * **Keyboard bindings** (§7.1, §11 — "move through the queue, answer the
 * selected item"), all on the listbox itself, none of them undocumented:
 *
 *   - `j` / `ArrowDown` — move the highlight to the next row (clamped, not
 *     wrapping — see `moveQueueSelection`)
 *   - `k` / `ArrowUp` — move the highlight to the previous row
 *   - `Enter` — navigate to the highlighted row's target (the same act as
 *     clicking its own button; the queue is a lens, §5)
 *   - `1`–`9` — on a highlighted `question` row, answer with the Nth
 *     option (1-indexed)
 *   - `a` — on a highlighted `approval` row, approve once
 *   - `d` — on a highlighted `approval` row, deny using whatever reason
 *     is currently typed into its row (a deny with no reason is refused
 *     server-side, §6.6 — "declining is feedback... never a bare
 *     refusal" — so the binding is a no-op until one is typed, same as
 *     the row's own deny button being disabled)
 *
 * A full shortcuts overlay (§11: "every binding appears in a shortcuts
 * overlay") does not exist anywhere in this codebase yet — a pre-existing
 * gap this panel does not close on its own — so these bindings are
 * documented here, in code, until that surface is built.
 *
 * Unstyled: mechanics only until the design package lands (fleet rule 5).
 */

import { useEffect, useState } from "react";
import { APPROVAL_ANSWER_OPTIONS } from "@plotroom/core";

import { moveQueueSelection, rankAttentionItems } from "./queue.js";
import type {
  AttentionDataSource,
  AttentionItem,
  TriageActionInput,
} from "./types.js";

export interface QueuePanelProps {
  readonly dataSource: AttentionDataSource;
  /** Selection-as-route (§5): the host's `select()`, the one navigation primitive. */
  readonly onNavigate: (nodeId: string) => void;
  /** Injectable so triage timestamps are testable without a real clock. */
  readonly now?: () => number;
  readonly triageAuthor?: TriageActionInput["by"];
}

const DEFAULT_SNOOZE_SECONDS = 60 * 60; // an hour: "bring it back later" (§4.5), not gone forever

function feedBadge(feed: AttentionItem["feed"]): string {
  switch (feed) {
    case "question":
      return "Q";
    case "approval":
      return "A";
    case "drift":
      return "D";
    case "health":
      return "H";
    case "completion":
      return "C";
    case "broadcast":
      return "B";
  }
}

export function QueuePanel({
  dataSource,
  onNavigate,
  now = () => Math.floor(Date.now() / 1000),
  triageAuthor,
}: QueuePanelProps) {
  const [items, setItems] = useState<readonly AttentionItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // A deny needs a reason (§6.6: "declining is feedback... never a bare
  // refusal") — typed per row, keyed by item id, so several approval rows
  // never clobber each other's draft.
  const [denyReasons, setDenyReasons] = useState<Record<string, string>>({});

  useEffect(() => {
    const unsubscribe = dataSource.subscribe((next) => {
      setItems(next);
      setSelectedId((current) =>
        current !== null && next.some((item) => item.id === current)
          ? current
          : (next[0]?.id ?? null),
      );
    });
    return unsubscribe;
  }, [dataSource]);

  // A data source is expected to already apply triage before emitting
  // (`createFixtureAttentionDataSource` does, and a live one will too, per
  // `types.ts`'s NORMATIVE rule: hiding a muted or currently-snoozed item
  // is the source's job) — this only ranks what it was given, over
  // `rankAttentionItems`, never re-filters against a ledger it has no real
  // copy of.
  const ranked = rankAttentionItems(items);

  function move(direction: "next" | "prev"): void {
    setSelectedId((current) => moveQueueSelection(ranked, current, direction));
  }

  function select(item: AttentionItem): void {
    setSelectedId(item.id);
    onNavigate(item.target.nodeId);
  }

  function triageInput(): TriageActionInput {
    return { at: now(), by: triageAuthor ?? { kind: "human" } };
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key === "j" || event.key === "ArrowDown") {
      event.preventDefault();
      move("next");
      return;
    }
    if (event.key === "k" || event.key === "ArrowUp") {
      event.preventDefault();
      move("prev");
      return;
    }

    const highlighted = ranked.find((item) => item.id === selectedId);
    if (!highlighted) return;

    if (event.key === "Enter") {
      event.preventDefault();
      select(highlighted);
      return;
    }

    if (highlighted.payload.kind === "question") {
      const index = Number(event.key) - 1;
      const option = highlighted.payload.options[index];
      if (Number.isInteger(index) && index >= 0 && option !== undefined) {
        event.preventDefault();
        void dataSource.answerQuestion(
          highlighted.id,
          option.id,
          triageInput(),
        );
        return;
      }
    }

    if (highlighted.payload.kind === "approval") {
      if (event.key === "a") {
        event.preventDefault();
        void dataSource.decideApproval(
          highlighted.id,
          "approve-once",
          triageInput(),
        );
        return;
      }
      if (event.key === "d") {
        const reason = denyReasons[highlighted.id]?.trim();
        if (reason) {
          event.preventDefault();
          void dataSource.decideApproval(
            highlighted.id,
            "deny",
            triageInput(),
            reason,
          );
        }
        return;
      }
    }
  }

  return (
    <ul
      data-testid="attention-queue"
      role="listbox"
      aria-label="attention queue"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      {ranked.length === 0 ? <li>nothing needs attention</li> : null}
      {ranked.map((item) => (
        <li
          key={item.id}
          data-testid={`queue-row-${item.id}`}
          role="option"
          aria-selected={item.id === selectedId}
        >
          <button type="button" onClick={() => select(item)}>
            [{feedBadge(item.feed)}] {item.summary}
          </button>

          {item.payload.kind === "question" ? (
            <span>
              {item.payload.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() =>
                    void dataSource.answerQuestion(
                      item.id,
                      option.id,
                      triageInput(),
                    )
                  }
                >
                  {option.label}
                </button>
              ))}
            </span>
          ) : null}

          {item.payload.kind === "approval" ? (
            <span>
              {APPROVAL_ANSWER_OPTIONS.map((option) =>
                option.requiresReason ? (
                  <span key={option.decision}>
                    <input
                      type="text"
                      aria-label={`${option.label} reason for ${item.id}`}
                      value={denyReasons[item.id] ?? ""}
                      onChange={(event) =>
                        setDenyReasons((current) => ({
                          ...current,
                          [item.id]: event.target.value,
                        }))
                      }
                    />
                    <button
                      type="button"
                      disabled={!denyReasons[item.id]?.trim()}
                      onClick={() =>
                        void dataSource.decideApproval(
                          item.id,
                          option.decision,
                          triageInput(),
                          denyReasons[item.id]?.trim(),
                        )
                      }
                    >
                      {option.label}
                    </button>
                  </span>
                ) : (
                  <button
                    key={option.decision}
                    type="button"
                    onClick={() =>
                      void dataSource.decideApproval(
                        item.id,
                        option.decision,
                        triageInput(),
                      )
                    }
                  >
                    {option.label}
                  </button>
                ),
              )}
            </span>
          ) : null}

          <button
            type="button"
            onClick={() => void dataSource.acknowledge(item.id, triageInput())}
          >
            acknowledge
          </button>
          <button
            type="button"
            onClick={() =>
              void dataSource.snooze(item.id, {
                ...triageInput(),
                snoozedUntil: now() + DEFAULT_SNOOZE_SECONDS,
              })
            }
          >
            snooze
          </button>
          <button
            type="button"
            onClick={() => void dataSource.mute(item.id, triageInput())}
          >
            mute
          </button>
        </li>
      ))}
    </ul>
  );
}
