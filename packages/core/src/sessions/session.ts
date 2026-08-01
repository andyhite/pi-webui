import type { Author } from "../author.js";
import type { CommandId, SessionId, WorkstreamId } from "../ids.js";
import type { SessionAccounting } from "./accounting.js";
import { startAccounting } from "./accounting.js";
import { NOT_DELETED, isDeleted, type SoftDeleteState } from "./deletion.js";
import type { SessionEnd } from "./end-states.js";
import type { SessionLaunchChoices, SessionRuntimeBinding } from "./runtime.js";

/**
 * Spec §3.6: a session is a live or completed agent run inside a workstream —
 * and a record the product owns: readable, resumable, forkable, deletable,
 * always. There is no distinction between a live session and a stored one, so
 * this is one type with an `end` that is null while it runs.
 */

/**
 * A producing session runs a command and ends on proven completion (§3.5); an
 * open session is a conversation the user ends. The distinction decides which
 * end states are reachable, not how the session is driven.
 */
export type SessionMode = "producing" | "open";

export interface Session {
  readonly id: SessionId;
  /** A session never leaves its workstream (§3.3). */
  readonly workstreamId: WorkstreamId;
  /** The command that started it; null for an open session. */
  readonly commandId: CommandId | null;
  readonly mode: SessionMode;
  /** Per-session choices, made at launch and visible after (§3.6). */
  readonly launch: SessionLaunchChoices;
  /**
   * Who initiated it. Every running session's chain terminates at a human
   * gesture, however many agent decisions sit in between (principle 2).
   */
  readonly initiatedBy: Author;
  /** Which adapter and which native session; persisted so resume/fork survive a restart. */
  readonly runtime: SessionRuntimeBinding;
  readonly accounting: SessionAccounting;
  /** Null while the session is live. */
  readonly end: SessionEnd | null;
  readonly deletion: SoftDeleteState;
  readonly startedAt: number;
}

export interface NewSession {
  readonly id: SessionId;
  readonly workstreamId: WorkstreamId;
  readonly commandId: CommandId | null;
  readonly mode: SessionMode;
  readonly launch: SessionLaunchChoices;
  readonly initiatedBy: Author;
  readonly runtime: SessionRuntimeBinding;
}

export function startSession(input: NewSession, at: number): Session {
  return {
    ...input,
    accounting: startAccounting(at),
    end: null,
    deletion: NOT_DELETED,
    startedAt: at,
  };
}

/**
 * One gesture creates one thing (principle 9): ending an already-ended session
 * keeps the first outcome. A retry or a reconnect that observes the end twice
 * must not rewrite "out of budget" into "stopped".
 */
export function endSession(session: Session, end: SessionEnd): Session {
  if (session.end) return session;
  return { ...session, end };
}

export function isRunning(session: Session): boolean {
  return session.end === null && !isDeleted(session);
}

/**
 * §3.7: content wires into a *running* session. Deleted sessions are still
 * readable — recoverability is not visibility on the board (principle 10) —
 * but they accept no injection.
 */
export function acceptsInjection(session: Session): boolean {
  return isRunning(session);
}
