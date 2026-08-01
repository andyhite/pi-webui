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
 * Unstyled: mechanics only until the design package lands (fleet rule 5).
 */

import { useEffect, useState } from "react";

import { moveQueueSelection, visibleAttentionItems } from "./queue.js";
import type {
  AttentionDataSource,
  AttentionItem,
  TriageActionInput,
} from "./types.js";
import { EMPTY_TRIAGE, type TriageLedger } from "@plotroom/core";

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
  // A data source is expected to already apply triage before emitting
  // (`createFixtureAttentionDataSource` does, and a live one will too, per
  // `types.ts`'s contract) — `visibleAttentionItems` is still run here,
  // against an always-empty ledger, purely for its ranking half: it
  // guarantees rank+raisedAt order for *any* conforming source, rather
  // than trusting every implementation to sort before it emits.
  const ledger: TriageLedger = EMPTY_TRIAGE;

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

  const ranked = visibleAttentionItems(items, ledger, now());

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
    } else if (event.key === "k" || event.key === "ArrowUp") {
      event.preventDefault();
      move("prev");
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
                  key={option}
                  type="button"
                  onClick={() =>
                    void dataSource.answerQuestion(
                      item.id,
                      option,
                      triageInput(),
                    )
                  }
                >
                  {option}
                </button>
              ))}
            </span>
          ) : null}

          {item.payload.kind === "approval" ? (
            <span>
              <button
                type="button"
                onClick={() =>
                  void dataSource.decideApproval(
                    item.id,
                    "approve",
                    triageInput(),
                  )
                }
              >
                approve
              </button>
              <button
                type="button"
                onClick={() =>
                  void dataSource.decideApproval(item.id, "deny", triageInput())
                }
              >
                deny
              </button>
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
