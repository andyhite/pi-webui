/**
 * Approval identifiers.
 *
 * The brands live here rather than in `src/ids.ts` for the same reason the claim
 * brands do (`claims/ids.ts`): the subtree is owned separately, and the technique
 * is the one `src/ids.ts` established — a nominal brand so ids of different kinds
 * cannot be swapped, and a short greppable prefix over a v4 UUID.
 */

declare const approvalBrand: unique symbol;

type Brand<T, B extends string> = T & { readonly [approvalBrand]: B };

/** One thing a session asked for and a human answered (§6.6). */
export type ApprovalId = Brand<string, "ApprovalId">;
/**
 * One standing allow/deny declared in advance — "a human decision about
 * capability made in advance, which is different in kind from a timer that
 * spends" (§6.6).
 */
export type PreGrantId = Brand<string, "PreGrantId">;

declare const crypto: { randomUUID(): string };

function newId<T extends string>(prefix: string): Brand<string, T> {
  return `${prefix}_${crypto.randomUUID()}` as Brand<string, T>;
}

export const newApprovalId = (): ApprovalId => newId<"ApprovalId">("appr");
export const newPreGrantId = (): PreGrantId => newId<"PreGrantId">("pregrant");
