/**
 * The attention queue (§7.1, §11): "a single ranked list of everything
 * wanting a decision, keyboard-driven, where each row carries enough
 * context to answer without opening anything." Selecting a row navigates
 * the canvas through the exact same selection-as-route primitive every
 * other entry point uses (§5) — the queue is a lens, not a place.
 *
 * In-place answers reuse the same shape the bubble layer already answers
 * questions with (`BubbleLayer.tsx`'s option buttons) rather than a second
 * question-answering widget: a `question` row renders its options as real
 * buttons, an `approval` row renders approve/deny, and every row — those
 * two included, per §7.1's "every feed supports acknowledge, snooze, and
 * mute" — carries the three triage verbs.
 *
 * **The cursor is the host's** (`useAttentionQueueCursor`), not this panel's,
 * because §11's queue verbs are keyboard verbs first: they have to work
 * whether or not this panel happens to be open, and a click and a keypress
 * must be the same act on the same selection. So every button below calls
 * the same cursor method the registered binding does — and the panel adds
 * only the two bindings that need something it owns: the arrows (a listbox's
 * expected keys) and `d`, which denies with the reason typed into the
 * highlighted row.
 *
 * Announced (§11): a listbox with `aria-activedescendant` naming the
 * highlighted row, so the highlight is announced and not merely drawn, and
 * `data-key-scope="queue"` so the queue's own keys are live exactly while it
 * has focus.
 *
 * Unstyled: mechanics only until the design package lands (fleet rule 5).
 */

import { useMemo, useRef, useState } from "react";
import { APPROVAL_ANSWER_OPTIONS } from "@plotroom/core";

import type { KeyBinding } from "../keyboard/bindings.js";
import { useKeyBindings } from "../keyboard/use-key-bindings.js";
import type { AttentionQueueCursor } from "./use-queue-cursor.js";
import type { AttentionItem } from "./types.js";

export interface QueuePanelProps {
  /** The host's cursor — one queue selection, shared with the bindings. */
  readonly cursor: AttentionQueueCursor;
}

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

export function QueuePanel({ cursor }: QueuePanelProps) {
  // A deny needs a reason (§6.6: "declining is feedback... never a bare
  // refusal") — typed per row, keyed by item id, so several approval rows
  // never clobber each other's draft.
  const [denyReasons, setDenyReasons] = useState<Record<string, string>>({});

  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const denyReasonsRef = useRef(denyReasons);
  denyReasonsRef.current = denyReasons;

  const bindings = useMemo<readonly KeyBinding[]>(
    () => [
      {
        kind: "dispatched",
        id: "queue-move-arrows",
        chords: [{ key: "ArrowDown" }, { key: "ArrowUp" }],
        keysLabel: "↓ / ↑",
        label: "move through the attention queue",
        description:
          "moves the highlight while the queue has focus — the same act as J/K",
        scope: "queue",
        run: (_event, chord) =>
          cursorRef.current.move(chord.key === "ArrowDown" ? "next" : "prev"),
      },
      {
        kind: "dispatched",
        id: "queue-navigate",
        chords: [{ key: "Enter" }],
        label: "go to the highlighted item",
        description:
          "moves the canvas to the highlighted row's node (the queue is a lens)",
        scope: "queue",
        run: () => cursorRef.current.navigate(),
      },
      {
        kind: "dispatched",
        id: "queue-deny",
        chords: [{ key: "d" }],
        label: "deny the highlighted approval",
        description:
          "denies with the reason typed in that row; a bare refusal is refused (§6.6)",
        scope: "queue",
        run: () => {
          const id = cursorRef.current.selectedId;
          if (id === null) return;
          cursorRef.current.deny(denyReasonsRef.current[id] ?? "");
        },
      },
    ],
    [],
  );
  useKeyBindings(bindings);

  const activeOptionId =
    cursor.selectedId === null
      ? undefined
      : `queue-option-${cursor.selectedId}`;

  return (
    <ul
      data-testid="attention-queue"
      data-key-scope="queue"
      role="listbox"
      aria-label="attention queue"
      tabIndex={0}
      {...(activeOptionId === undefined
        ? {}
        : { "aria-activedescendant": activeOptionId })}
    >
      {cursor.items.length === 0 ? <li>nothing needs attention</li> : null}
      {cursor.items.map((item) => (
        <li
          key={item.id}
          id={`queue-option-${item.id}`}
          data-testid={`queue-row-${item.id}`}
          role="option"
          aria-selected={item.id === cursor.selectedId}
        >
          <button type="button" onClick={() => cursor.navigate(item.id)}>
            [{feedBadge(item.feed)}] {item.summary}
          </button>

          {item.payload.kind === "question" ? (
            <span>
              {item.payload.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => cursor.answer(option.id, item.id)}
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
                        cursor.deny(denyReasons[item.id] ?? "", item.id)
                      }
                    >
                      {option.label}
                    </button>
                  </span>
                ) : (
                  <button
                    key={option.decision}
                    type="button"
                    onClick={() => cursor.approve(item.id)}
                  >
                    {option.label}
                  </button>
                ),
              )}
            </span>
          ) : null}

          <button type="button" onClick={() => cursor.acknowledge(item.id)}>
            acknowledge
          </button>
          <button type="button" onClick={() => cursor.snooze(item.id)}>
            snooze
          </button>
          <button type="button" onClick={() => cursor.mute(item.id)}>
            mute
          </button>
        </li>
      ))}
    </ul>
  );
}
