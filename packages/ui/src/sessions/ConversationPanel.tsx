/**
 * The Conversation panel (spec §6.1, §6.2, §11): streaming transcript,
 * reasoning distinct from output, tool calls with their input and output as
 * one collapsible unit, message-level actions, export to a portable
 * document. Bounded-transcript UI: a visible marker where content was
 * released, and a load-back affordance over the `SessionDataSource` seam.
 * A status header reads phase + accounting straight off core session types,
 * kept live via `dataSource.subscribeSession` — the panel only takes a
 * `sessionId`, never a snapshot of the session itself, so it always shows
 * whatever the data source currently knows (Stage 2: real, server-derived
 * status; fixtures otherwise).
 *
 * The composer's send is wired to injection (§6.5, `POST /sessions/:id/
 * inject`, Stage 2) via `onSend`; `sendDisabledReason` still disables it
 * with a visible reason whenever nothing can accept it (offline/fixture
 * mode) — the host sets it, this panel never pretends a click delivered
 * something it did not. Drafts and prompt history persist per session
 * through the same durable-store seam `placement/store.ts` established,
 * unaffected by whether sending is wired.
 *
 * Unstyled: mechanics only until the design package lands (fleet rule 5).
 * `<details>`/`<summary>` supplies collapsible mechanics for tool calls with
 * no styling decision involved.
 */

import { useEffect, useState } from "react";
import type { SessionId, Transcript, TranscriptExport } from "@plotroom/core";
import { restoreReleased } from "@plotroom/core";

import type {
  InjectionLedgerEntry,
  SessionDataSource,
  SessionDetail,
} from "./data-source.js";
import type { SessionDraftsStore } from "./drafts.js";
import { exportIncompleteMessage, exportTranscriptAsync } from "./export.js";
import { buildTranscriptView } from "./transcript-view.js";
import type { TranscriptViewItem } from "./transcript-view.js";
import {
  DEFAULT_TRANSCRIPT_WINDOW,
  computeTailWindow,
  growTranscriptWindow,
  hasEarlierTurns,
} from "./windowing.js";

export interface ConversationPanelProps {
  readonly sessionId: SessionId;
  readonly dataSource: SessionDataSource;
  readonly draftsStore: SessionDraftsStore;
  /** Called only when sending is actually enabled (no `sendDisabledReason`). */
  readonly onSend?: (sessionId: SessionId, text: string) => void;
  /**
   * Set (with the reason) whenever nothing can accept a sent message —
   * disables the composer rather than silently pretending to deliver it.
   * Injection has no server endpoint yet (§6.5, Batch 3 scope).
   */
  readonly sendDisabledReason?: string | undefined;
  /** Placeholder hook: wiring a message as context is Epic 3.5/5.2 territory. */
  readonly onWireAsContext?: (
    sessionId: SessionId,
    turnOrdinal: number,
    item: TranscriptViewItem,
  ) => void;
  /**
   * The transcript checkpoint gesture (§3.6, §4.5): a live transcript
   * versions on checkpoint, not on every turn — this is the human half of
   * that rule (`POST /api/sessions/:id/checkpoint`, already live on the
   * server). Absent — like `sendDisabledReason` — the button still renders,
   * disabled with `checkpointDisabledReason`, never silently doing nothing.
   */
  readonly onCheckpointTranscript?: (sessionId: SessionId) => void;
  readonly checkpointDisabledReason?: string | undefined;
  /**
   * Resume vs fork (§6.3): "continuing a session is an explicit choice
   * between resume and fork — never an implicit consequence of typing into
   * it." Once `detail.session.end` is set, this panel replaces the composer
   * with exactly these two choices — there is no third path back to typing
   * into an ended session, and neither fires without the operator picking
   * one.
   */
  readonly onResume?: (sessionId: SessionId) => void;
  /** Forks from the given 1-based turn (defaults to the transcript's last turn). */
  readonly onFork?: (sessionId: SessionId, turn: number) => void;
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
  sessionId,
  dataSource,
  draftsStore,
  onSend,
  sendDisabledReason,
  onWireAsContext,
  onCheckpointTranscript,
  checkpointDisabledReason,
  onResume,
  onFork,
  copyToClipboard = defaultCopyToClipboard,
}: ConversationPanelProps) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  // Bounded rendering (§6.1 mechanics): a live tail window, not the whole
  // transcript — reset per session so switching sessions never carries a
  // stale "loaded earlier turns" state into an unrelated one.
  const [windowSize, setWindowSize] = useState(DEFAULT_TRANSCRIPT_WINDOW);
  const [transcript, setTranscript] = useState<Transcript>({
    sessionId,
    turns: [],
  });
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<readonly string[]>([]);
  // The whole export result, not just its document: §6.1's completeness
  // contract ("an export of a released transcript is complete") is a fact
  // about the export, and discarding `complete`/`unavailable` here would
  // paper over exactly the failure path principle 12 says must be reported,
  // never silently swallowed.
  const [exportResult, setExportResult] = useState<TranscriptExport | null>(
    null,
  );
  const [loadedBack, setLoadedBack] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  // The injection ledger (§6.5): queued→delivered, live. A delivered entry
  // also shows up as its own transcript entry once the runtime has taken
  // it into a turn; this list is what makes "queued" visible before that.
  const [injections, setInjections] = useState<readonly InjectionLedgerEntry[]>(
    [],
  );
  // Resume-vs-fork (§6.3): the turn to fork from. Null until the operator
  // edits it, so the default tracks the transcript's own last turn instead
  // of freezing at whatever it was when the panel first rendered.
  const [forkTurn, setForkTurn] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setTranscript({ sessionId, turns: [] });
    setWindowSize(DEFAULT_TRANSCRIPT_WINDOW);

    void draftsStore.load(sessionId).then((state) => {
      if (cancelled) return;
      setDraft(state.draft);
      setHistory(state.history);
    });
    const unsubscribeSession = dataSource.subscribeSession(
      sessionId,
      (next) => {
        if (cancelled) return;
        setDetail(next);
      },
    );
    const unsubscribeTranscript = dataSource.subscribeTranscript(
      sessionId,
      (event) => {
        if (cancelled) return;
        setTranscript(event.transcript);
      },
    );
    const unsubscribeInjections = dataSource.subscribeInjections(
      sessionId,
      (event) => {
        if (cancelled) return;
        setInjections(event.injections);
      },
    );
    return () => {
      cancelled = true;
      unsubscribeSession();
      unsubscribeTranscript();
      unsubscribeInjections();
    };
  }, [sessionId, dataSource, draftsStore]);

  const turns = buildTranscriptView(transcript);
  // Bounded rendering (§6.1 mechanics, Epic 5.1 finish): a live tail window
  // of turns, not the whole history — "load earlier turns" grows it one
  // step at a time rather than rendering a thousand-turn DOM up front.
  const turnWindow = computeTailWindow(turns.length, windowSize);
  const windowedTurns = turns.slice(turnWindow.start, turnWindow.end);

  function handleDraftChange(next: string): void {
    setDraft(next);
    void draftsStore.saveDraft(sessionId, next);
  }

  function handleSend(): void {
    if (sendDisabledReason !== undefined) return;
    if (draft.trim() === "") return;
    const text = draft;
    void draftsStore.recordSent(sessionId, text).then(() => {
      void draftsStore.load(sessionId).then((state) => {
        setDraft(state.draft);
        setHistory(state.history);
      });
    });
    onSend?.(sessionId, text);
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
      sessionId,
      callId,
      entry.released,
    );
    if (content === null) return;
    setLoadedBack((current) => new Map(current).set(callId, content));
    setTranscript((current) => restoreReleased(current, callId, content));
  }

  async function handleExport(): Promise<void> {
    const result = await exportTranscriptAsync(transcript, (marker, callId) =>
      dataSource.loadReleasedContent(sessionId, callId, marker),
    );
    setExportResult(result);
  }

  function handleLoadEarlierTurns(): void {
    setWindowSize((current) => growTranscriptWindow(current, turns.length));
  }

  function handleCheckpointTranscript(): void {
    if (checkpointDisabledReason !== undefined) return;
    onCheckpointTranscript?.(sessionId);
  }

  if (detail === null) {
    return <div role="status">loading session {sessionId}…</div>;
  }

  const { session, status } = detail;

  return (
    <div>
      <div role="status">
        phase: {status.phase.kind} · busy: {String(status.facts.busy)} · wants
        attention: {String(status.facts.wantsAttention)} · turns:{" "}
        {session.accounting.turns} · tokens:{" "}
        {session.accounting.tokens.input + session.accounting.tokens.output} ·
        cost: ${session.accounting.costUsd.toFixed(4)} (
        {session.accounting.costBasis}) ·{" "}
        <span data-testid="session-end">
          end: {session.end?.kind ?? "running"}
        </span>
      </div>

      <div>
        <button
          type="button"
          onClick={handleCheckpointTranscript}
          disabled={checkpointDisabledReason !== undefined}
          title={checkpointDisabledReason}
        >
          checkpoint transcript
        </button>
        {checkpointDisabledReason !== undefined ? (
          <div data-testid="checkpoint-disabled-reason">
            {checkpointDisabledReason}
          </div>
        ) : null}
      </div>

      <div>
        {hasEarlierTurns(turnWindow) ? (
          <button type="button" onClick={handleLoadEarlierTurns}>
            load earlier turns ({turnWindow.start} not shown)
          </button>
        ) : null}
        {windowedTurns.map((turn) => (
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
                      onWireAsContext?.(sessionId, turn.ordinal, item)
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
          <div>
            <pre data-testid="export-document">{exportResult.document}</pre>
            {!exportResult.complete ? (
              <div data-testid="export-incomplete">
                {exportIncompleteMessage(exportResult.unavailable)}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div>
        {session.end !== null ? (
          // Resume-vs-fork (§6.3): the composer is replaced entirely, not
          // merely disabled — typing into an ended session has no
          // disposition of its own, so there is no textarea here for it to
          // fall back to. Two explicit choices, nothing implicit.
          <div data-testid="resume-or-fork">
            <div>
              this session has ended — resume it, or fork from a point (§6.3)
            </div>
            <button
              type="button"
              onClick={() => onResume?.(sessionId)}
              disabled={!onResume}
            >
              resume
            </button>
            <label>
              fork from turn
              <input
                type="number"
                min={1}
                value={forkTurn ?? transcript.turns.at(-1)?.ordinal ?? 1}
                onChange={(event) =>
                  setForkTurn(Number(event.target.value) || 1)
                }
              />
            </label>
            <button
              type="button"
              onClick={() =>
                onFork?.(
                  sessionId,
                  forkTurn ?? transcript.turns.at(-1)?.ordinal ?? 1,
                )
              }
              disabled={!onFork}
            >
              fork
            </button>
          </div>
        ) : (
          <>
            <div>prompt history</div>
            <ul>
              {history.map((entry, index) => (
                <li key={index}>
                  <button
                    type="button"
                    onClick={() => recallFromHistory(entry)}
                  >
                    {entry}
                  </button>
                </li>
              ))}
            </ul>
            <textarea
              value={draft}
              onChange={(event) => handleDraftChange(event.target.value)}
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={sendDisabledReason !== undefined}
              title={sendDisabledReason}
            >
              send
            </button>
            {sendDisabledReason !== undefined ? (
              <div data-testid="send-disabled-reason">{sendDisabledReason}</div>
            ) : null}
          </>
        )}
        {injections.length > 0 ? (
          <ul>
            {injections.map((entry) => (
              <li
                key={entry.id}
                data-testid={`injection-${entry.id}`}
                data-injection-status={
                  entry.refusedAt !== null
                    ? "refused"
                    : entry.deliveredAt === null
                      ? "queued"
                      : "delivered"
                }
              >
                {entry.text} —{" "}
                {entry.refusedAt !== null
                  ? "refused"
                  : entry.deliveredAt === null
                    ? "queued"
                    : "delivered"}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
