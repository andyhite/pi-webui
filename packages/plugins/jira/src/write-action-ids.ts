/**
 * The ids of Jira's write actions (§9.2), in a leaf module of their own.
 *
 * An id is a *name*, and the two halves of this plugin both need it: the host
 * half declares the action under it (`writes.ts`, which re-exports these so
 * every existing import site is unchanged), and the renderer half offers the
 * transition as a card action addressed by the same id (`renderers.ts`). A card
 * that spelled the id itself would be the second spelling of one fact, and a
 * renderer that imported it from `writes.ts` would drag the whole transport —
 * `Buffer` and all — into the browser bundle the card renders in. So the names
 * live here, importing nothing, and both halves read them.
 */

export const COMMENT_ACTION = "comment";
export const TRANSITION_ACTION = "transition";
export const ASSIGN_ACTION = "assign";
export const UPDATE_SUMMARY_ACTION = "update-summary";
export const CREATE_ISSUE_ACTION = "create-issue";
