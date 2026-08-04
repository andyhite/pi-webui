/**
 * The Settings panel's draft rules (§11), as functions rather than component
 * bodies, so the two that are load-bearing are testable without a DOM:
 *
 *  - **A sensitive value is never echoed into the field.** The draft is
 *    seeded from the row for every other type; for a sensitive one it is
 *    always empty — before a write and, just as importantly, after one, or
 *    the secret the operator typed stays sitting in the input for as long as
 *    the panel is open, which is the one thing `sensitive` exists to prevent.
 *  - **An empty *number* field is not a zero.** `Number("")` is `0`, so a
 *    cleared number field wrote a real zero, silently — and a zero *means*
 *    something for more than one setting in the catalog ("zero disables the
 *    schedule"). Clearing an override is `remove override`'s own verb; a save
 *    refuses rather than inventing a number the operator never typed. The rule
 *    stops at numbers deliberately: an emptied `string[]` field is the empty
 *    list, which is a value a caller can mean (`trustedOrigins`), and an empty
 *    string is a string.
 *
 * `checkDraft` mirrors the server's `checkSettingValue` on purpose: the same
 * shape (a reason as the tail of `"<key>" must be …`), and the panel names the
 * setting the same way the route does, so a refusal from either side reads as
 * one rule rather than two vocabularies in the same element. It judges what
 * only the panel can see — the draft *string* — and leaves every bound to the
 * server, which is the only place a bound is stated.
 */

import type { SettingRow } from "./types.js";

/** What the field shows for a row — never a sensitive value, at any point. */
export function draftFromValue(row: SettingRow): string {
  if (row.sensitive) return "";
  if (row.type === "string[]") {
    return Array.isArray(row.value) ? row.value.join(", ") : "";
  }
  if (row.value === null || row.value === undefined) return "";
  return String(row.value);
}

/** The value a write carries for this draft. Call `checkDraft` first. */
export function parseDraft(row: SettingRow, draft: string): unknown {
  switch (row.type) {
    case "boolean":
      return draft === "true";
    case "number":
      return Number(draft);
    case "string[]":
      return draft
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    default:
      return draft;
  }
}

/** Why this draft cannot be saved, as the tail of "X must be …", or `null`. */
export function checkDraft(row: SettingRow, draft: string): string | null {
  if (row.type !== "number") return null;
  if (draft.trim().length === 0) {
    return 'a finite number — an empty field is not a zero, and "remove override" is how a value is cleared';
  }
  return Number.isFinite(Number(draft))
    ? null
    : `a finite number — "${draft}" is not one`;
}
