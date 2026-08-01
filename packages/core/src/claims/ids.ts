/**
 * Claim identifiers.
 *
 * The brands live here rather than in `src/ids.ts` because the claims subtree is
 * owned separately (development plan, "Tracks and timeline"); the technique is
 * the one `src/ids.ts` established — a nominal brand so ids of different kinds
 * cannot be swapped, and a short greppable prefix over a v4 UUID.
 */

declare const claimBrand: unique symbol;

type Brand<T, B extends string> = T & { readonly [claimBrand]: B };

/** One lease on one path (§3.4). */
export type ClaimId = Brand<string, "ClaimId">;
/** One session's place in a waitlist — visible state, so it is addressable (§3.4). */
export type ClaimWaitId = Brand<string, "ClaimWaitId">;
/** One pre-granted allow/deny rule declared by a holder (§3.4). */
export type ClaimPolicyId = Brand<string, "ClaimPolicyId">;
/**
 * A canonical path's comparison key: case-folded, separator-normalized, with no
 * `.`/`..` segments. Branded so a raw string can never be compared against one
 * by accident — canonicalization is the only way to obtain one.
 */
export type PathKey = Brand<string, "PathKey">;
/** An agent's proposal awaiting a human's acceptance (principle 1, §3.8). */
export type ProposalId = Brand<string, "ProposalId">;

declare const crypto: { randomUUID(): string };

function newId<T extends string>(prefix: string): Brand<string, T> {
  return `${prefix}_${crypto.randomUUID()}` as Brand<string, T>;
}

export const newClaimId = (): ClaimId => newId<"ClaimId">("claim");
export const newClaimWaitId = (): ClaimWaitId =>
  newId<"ClaimWaitId">("claimwait");
export const newClaimPolicyId = (): ClaimPolicyId =>
  newId<"ClaimPolicyId">("claimpol");
export const newProposalId = (): ProposalId => newId<"ProposalId">("proposal");

/** Internal: the key brand is applied by `canonicalizePath`, nowhere else. */
export function asPathKey(value: string): PathKey {
  return value as PathKey;
}
