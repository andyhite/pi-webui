/**
 * DRAFT — the plugin contract surface (§10.1, §10.2). **Unstable. Wired to nothing.**
 *
 * Epic 7.1's contract **freezes in Phase 7**, not here. This subtree exists so that
 * freeze starts from shapes someone has read against the code that already
 * implements each contribution point natively — `contributions.ts` names those
 * counterparts one by one, and `docs/plugin-contract-draft.md` is the reviewable
 * version of the same argument.
 *
 * Nothing imports this. `CONTRACT_VERSION` in the package root stays `0`; the host
 * still speaks the minimal load/ping/dispose protocol it shipped with. The one
 * runtime value here is the marker below, so a reader who finds these types in a
 * build can tell what they are looking at.
 */

/**
 * What this draft is, in a string a log line can carry. Not a contract version: the
 * contract has no version until it freezes, and numbering a draft is how a draft
 * gets depended on.
 */
export const DRAFT_CONTRACT_STATUS = "draft-unstable-epic-7.1" as const;

export * from "./contributions.js";
export * from "./permissions.js";
