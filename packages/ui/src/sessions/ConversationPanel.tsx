/**
 * The Conversation panel (spec §6.1, §6.2, §11): streaming transcript,
 * reasoning distinct from output, tool calls with their input and output as
 * one collapsible unit, message-level actions, export to a portable
 * document. Bounded-transcript UI: a visible marker where content was
 * released, and a load-back affordance over the `SessionDataSource` seam.
 * A status header reads phase + accounting straight off core session types.
 * The composer's send is a hook — a no-op until Stage 2 wires a live
 * session — but drafts and prompt history persist per session through the
 * same durable-store seam `placement/store.ts` established.
 *
 * Unstyled: mechanics only until the design package lands (fleet rule 5).
 * `<details>`/`<summary>` supplies collapsible mechanics for tool calls with
 * no styling decision involved.
 */

import { useEffect, useState } from "react";
import type {
  Session,
  SessionId,
  SessionStatus,
  Transcript,
} from "@plotroom/core";
import { restoreReleased } from "@plotroom/core";

import type { SessionDataSource } from "./data-source.js";
import type { SessionDraftsStore } from "./drafts.js";
import { exportTranscriptAsync } from "./export.js";
import { buildTranscriptView } from "./transcript-view.js";
import type { TranscriptViewItem } from "./transcript-view.js";

export interface ConversationPanelProps {
  readonly session: Session;
  readonly status: SessionStatus;
  readonly dataSource: SessionDataSource;
  readonly draftsStore: SessionDraftsStore;
  readonly now: () => number;
  /** No-op against fixtures until Stage 2 wires a live session (§6.5+). */
  readonly onSend?: (sessionId: SessionId, text: string) => void;
  /** Placeholder hook: wiring a message as context is Epic 3.5/5.2 territory. */
  readonly onWireAsContext?: (
    sessionId: SessionId,
    turnOrdinal: number,
    item: TranscriptViewItem,
  ) => void;
  /** Injectable so copy is testable without a real clipboard. */
  readonly copyToClipboard?: (text: string) => void;
}

function defaultCopyToClipboard(text: string): void {
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    void navigator.clipboard.writeText(text);
  }
}

function itemText(item: TranscriptViewItem): string {
  switch (item.kind) {
    case "reasoning":
    case "output":
    case "injection":
      return item.text;
    case "tool-call":
      return item.result
        ? `${item.toolName}(${item.input}) -> ${item.result.output}`
        : `${item.toolName}(${item.input})`;
  }
}

export function ConversationPanel({
  session,
  status,
  dataSource,
  draftsStore,
  now,
  onSend,
  onWireAsContext,
  copyToClipboard = defaultCopyToClipboard,
}: ConversationPanelProps) {
  const [transcript, setTranscript] = useState<Transcript>({
    sessionId: session.id,
    turns: [],
  });
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<readonly string[]>([]);
  const [exportResult, setExportResult] = useState<string | null>(null);
  const [loadedBack, setLoadedBack] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );

  useEffect(() => {
    let cancelled = false;
    void draftsStore.load(session.id).then((state) => {
      if (cancelled) return;
      setDraft(state.draft);
      setHistory(state.history);
    });
    const unsubscribe = dataSource.subscribeTranscript(session.id, (event) => {
      if (cancelled) return;
      setTranscript(event.transcript);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [session.id, dataSource, draftsStore]);

  const turns = buildTranscriptView(transcript);

  function handleDraftChange(next: string): void {
    setDraft(next);
    void draftsStore.saveDraft(session.id, next);
  }

  function handleSend(): void {
    if (draft.trim() === "") return;
    const text = draft;
    void draftsStore.recordSent(session.id, text).then(() => {
      void draftsStore.load(session.id).then((state) => {
        setDraft(state.draft);
        setHistory(state.history);
      });
    });
    onSend?.(session.id, text);
  }

  function recallFromHistory(text: string): void {
    handleDraftChange(text);
  }

  async function handleLoadBack(callId: string): Promise<void> {
    const entry = transcript.turns
      .flatMap((turn) => turn.entries)
      .find(
        (candidate) =>
          candidate.kind === "tool-result" && candidate.callId === callId,
      );
    if (!entry || entry.kind !== "tool-result" || !entry.released) return;
    const content = await dataSource.loadReleasedContent(
      session.id,
      callId,
      entry.released,
    );
    if (content === null) return;
    setLoadedBack((current) => new Map(current).set(callId, content));
    setTranscript((current) => restoreReleased(current, callId, content));
  }

  async function handleExport(): Promise<void> {
    const result = await exportTranscriptAsync(transcript, (marker, callId) =>
      dataSource.loadReleasedContent(session.id, callId, marker),
    );
    setExportResult(result.document);
  }

  return (
    <div>
      <div role="status">
        phase: {status.phase.kind} · busy: {String(status.facts.busy)} · wants
        attention: {String(status.facts.wantsAttention)} · turns:{" "}
        {session.accounting.turns} · tokens:{" "}
        {session.accounting.tokens.input + session.accounting.tokens.output} ·
        cost: ${session.accounting.costUsd.toFixed(4)} (
        {session.accounting.costBasis})
      </div>

      <div>
        {turns.map((turn) => (
          <div key={turn.ordinal}>
            <div>turn {turn.ordinal}</div>
            <ul>
              {turn.items.map((item, index) => (
                <li key={index}>
                  {item.kind === "reasoning" ? (
                    <div data-transcript-kind="reasoning">
                      [reasoning] {item.text}
                    </div>
                  ) : null}
                  {item.kind === "output" ? (
                    <div data-transcript-kind="output">{item.text}</div>
                  ) : null}
                  {item.kind === "injection" ? (
                    <div data-transcript-kind="injection">
                      [injected by {item.author.kind}] {item.text}
                    </div>
                  ) : null}
                  {item.kind === "tool-call" ? (
                    <details data-transcript-kind="tool-call">
                      <summary>
                        {item.toolName}{" "}
                        {item.result === null ? "(running)" : ""}
                      </summary>
                      <div>input: {item.input}</div>
                      {item.result ? (
                        item.result.released ? (
                          <div>
                            released · {item.result.released.bytes} bytes ·{" "}
                            {loadedBack.get(item.callId) ??
                              item.result.released.contentHash}
                            <button
                              type="button"
                              onClick={() => void handleLoadBack(item.callId)}
                            >
                              load back
                            </button>
                          </div>
                        ) : (
                          <div>
                            output: {item.result.output}
                            {item.result.isError ? " (error)" : ""}
                          </div>
                        )
                      ) : null}
                    </details>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => copyToClipboard(itemText(item))}
                  >
                    copy
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onWireAsContext?.(session.id, turn.ordinal, item)
                    }
                  >
                    wire as context
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div>
        <button type="button" onClick={() => void handleExport()}>
          export
        </button>
        {exportResult !== null ? (
          <pre data-testid="export-document">{exportResult}</pre>
        ) : null}
      </div>

      <div>
        <div>prompt history</div>
        <ul>
          {history.map((entry, index) => (
            <li key={index}>
              <button type="button" onClick={() => recallFromHistory(entry)}>
                {entry}
              </button>
            </li>
          ))}
        </ul>
        <textarea
          value={draft}
          onChange={(event) => handleDraftChange(event.target.value)}
        />
        <button type="button" onClick={handleSend}>
          send
        </button>
      </div>

      <div>{now()}</div>
    </div>
  );
}
