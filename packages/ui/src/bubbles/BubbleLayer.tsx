/**
 * Bubble rendering (spec §5, §6.4, §6.5), DOM, unstyled (fleet rule 5): each
 * `BubblePlacement` (`placement.ts`) draws as one positioned element —
 * nothing here decides *where*, that is the pure engine's job; this only
 * turns a rect and a kind into markup.
 *
 * Live-region-friendly structurally (a11y proper is Phase 8, per the spec's
 * "don't block it structurally" note): every bubble is `role="status"` with
 * `aria-live="polite"`, so a screen reader announces new/changed bubble
 * text without this track having to build the full attention-surface
 * wiring yet. A tool-in-flight chip carries its own `data-bubble-kind` so
 * it is structurally distinct from the saying bubble it stacks above/below
 * (§5: "a tool in flight shows as a distinct chip"), and a question bubble
 * renders its options as real `<button>`s, answerable inline (§6.4).
 */

import type { BubblePlacement } from "./placement.js";
import type { BubbleSource } from "./model.js";

export interface BubbleLayerProps {
  readonly placements: readonly BubblePlacement[];
  /** Called only for a `question` bubble's option — mechanics, wired to a `QuestionDataSource` by the host. */
  readonly onAnswerQuestion?:
    ((source: BubbleSource, option: string) => void) | undefined;
}

function QuestionOptions({
  source,
  onAnswer,
}: {
  readonly source: BubbleSource;
  readonly onAnswer:
    ((source: BubbleSource, option: string) => void) | undefined;
}) {
  const options = source.options ?? [];
  const answered = source.answeredValue ?? null;
  return (
    <div role="group" aria-label="answer inline">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          disabled={answered !== null}
          aria-pressed={option === answered}
          onClick={() => onAnswer?.(source, option)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function BubbleContent({
  source,
  onAnswerQuestion,
}: {
  readonly source: BubbleSource;
  readonly onAnswerQuestion:
    ((source: BubbleSource, option: string) => void) | undefined;
}) {
  if (source.kind === "tool-in-flight") {
    return (
      <span data-bubble-chip="tool-in-flight">running: {source.text}</span>
    );
  }
  if (source.kind === "injection") {
    return (
      <div data-injection-status={source.injectionStatus}>{source.text}</div>
    );
  }
  if (source.kind === "question") {
    return (
      <div>
        <div>{source.text}</div>
        <QuestionOptions source={source} onAnswer={onAnswerQuestion} />
      </div>
    );
  }
  return <div>{source.text}</div>;
}

export function BubbleLayer({
  placements,
  onAnswerQuestion,
}: BubbleLayerProps) {
  return (
    <>
      {placements.map((placement) =>
        placement.kind === "bubble" ? (
          <div
            key={placement.source.id}
            role="status"
            aria-live="polite"
            data-testid={`bubble-${placement.source.id}`}
            data-bubble-kind={placement.source.kind}
            style={{
              position: "absolute",
              left: placement.rect.x,
              top: placement.rect.y,
              width: placement.rect.width,
              minHeight: placement.rect.height,
              zIndex: 6,
            }}
          >
            <BubbleContent
              source={placement.source}
              onAnswerQuestion={onAnswerQuestion}
            />
          </div>
        ) : (
          <div
            key={`collapsed-${placement.nodeId}`}
            role="status"
            data-testid={`bubble-collapsed-${placement.nodeId}`}
            data-bubble-collapsed-count={placement.sourceIds.length}
            style={{
              position: "absolute",
              left: placement.rect.x,
              top: placement.rect.y,
              width: placement.rect.width,
              height: placement.rect.height,
              zIndex: 6,
            }}
          >
            {placement.sourceIds.length}
          </div>
        ),
      )}
    </>
  );
}
