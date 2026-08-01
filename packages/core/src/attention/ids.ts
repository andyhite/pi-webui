import { driftItemKey } from "../sessions/triage.js";
import type { HealthAlertKind } from "./types.js";

/**
 * Attention item ids, derived from the fact rather than minted (§7.1).
 *
 * Stability across a resync is the whole requirement: the outbound edge-trigger
 * (§7.3) and the queue's own selection both fold state forward **by id** across
 * separate emissions, so an id that changed per read would re-notify every open
 * item on the next one and silently drop the queue's highlight. Every id here is
 * a function of the underlying record, and `driftItemKey` is reused verbatim
 * because triage already keys drift that way (§4.5) — one ledger, one key.
 */
export function questionItemId(questionId: string): string {
  return `question:${questionId}`;
}

export function approvalItemId(approvalId: string): string {
  return `approval:${approvalId}`;
}

export { driftItemKey };

/**
 * A health alert's id names its subject, not its reading: "this session is idle"
 * is one item however many times it is derived, so acknowledging it stays
 * acknowledged and the alert clearing and returning is one new item rather than a
 * stream of them.
 */
export function healthItemId(alert: HealthAlertKind, subject: string): string {
  return `health:${alert}:${subject}`;
}

export function completionItemId(sessionId: string): string {
  return `completion:${sessionId}`;
}

export function broadcastItemId(broadcastId: string): string {
  return `broadcast:${broadcastId}`;
}
