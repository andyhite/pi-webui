import type { SessionId } from "../ids.js";
import type { Claim, ClaimState, ClaimWait } from "./model.js";
import { claimById, claimWaitReason, type ClaimWaitReason } from "./model.js";
import { describePath, type ClaimPath } from "./paths.js";

/**
 * Deadlock detection (§3.4).
 *
 * "A holds `src/api/` and waits on `src/ui/`; B holds `src/ui/` and waits on
 * `src/api/`. The claim manager detects the wait-for cycle and refuses the newest
 * claim with an actionable message — _granting this would deadlock; you hold
 * `src/api/`_ — rather than letting two sessions sit forever."
 *
 * The graph is over *sessions*, not paths: a waiter waits for whoever must act
 * before it can proceed — the holders of the blocking claims, or the grantor who
 * must approve. The operator is never a node in it: they never wait, so no cycle
 * can run through them, which is also why force-release is always available as
 * the escape hatch.
 */

export interface WaitEdge {
  readonly from: SessionId;
  readonly to: SessionId;
  /** The path being waited on, so the message can name it. */
  readonly path: ClaimPath;
  readonly reason: ClaimWaitReason;
}

export function waitForEdges(state: ClaimState): readonly WaitEdge[] {
  return state.waits.flatMap((wait) => edgesForWait(state, wait));
}

export function edgesForWait(
  state: ClaimState,
  wait: ClaimWait,
): readonly WaitEdge[] {
  const reason = claimWaitReason(wait);
  const blockedOn: Claim[] = [];

  for (const claimId of wait.blockedByClaimIds) {
    const claim = claimById(state, claimId);
    if (claim) blockedOn.push(claim);
  }
  // An unanswered approval is a wait on the grantor, exactly like a wait on a
  // holder: A cannot proceed until B acts. A cycle through one deadlocks just as
  // hard as a cycle through the other.
  if (reason === "approval" && wait.grantorClaimId !== null) {
    const grantor = claimById(state, wait.grantorClaimId);
    if (grantor) blockedOn.push(grantor);
  }

  const edges: WaitEdge[] = [];
  for (const blocker of blockedOn) {
    if (blocker.holder.kind !== "session") continue;
    if (blocker.holder.sessionId === wait.sessionId) continue;
    edges.push({
      from: wait.sessionId,
      to: blocker.holder.sessionId,
      path: wait.path,
      reason,
    });
  }
  return edges;
}

/**
 * The cycle through `start`, if adding `candidate` closes one.
 *
 * Returned as the sessions in cycle order beginning at `start`, so the refusal
 * can walk it back to the caller: "you hold X, which B is waiting on".
 */
export function findWaitCycle(
  edges: readonly WaitEdge[],
  candidate: readonly WaitEdge[],
): readonly WaitEdge[] | null {
  const all = [...edges, ...candidate];
  const outgoing = new Map<SessionId, WaitEdge[]>();
  for (const edge of all) {
    const list = outgoing.get(edge.from);
    if (list) list.push(edge);
    else outgoing.set(edge.from, [edge]);
  }

  for (const seed of candidate) {
    const path = walkBack(outgoing, seed);
    if (path) return path;
  }
  return null;
}

/** Depth-first search for a way from `seed.to` back to `seed.from`. */
function walkBack(
  outgoing: ReadonlyMap<SessionId, readonly WaitEdge[]>,
  seed: WaitEdge,
): readonly WaitEdge[] | null {
  const visited = new Set<SessionId>([seed.from]);

  const search = (
    at: SessionId,
    trail: readonly WaitEdge[],
  ): readonly WaitEdge[] | null => {
    for (const edge of outgoing.get(at) ?? []) {
      if (edge.to === seed.from) return [...trail, edge];
      if (visited.has(edge.to)) continue;
      visited.add(edge.to);
      const found = search(edge.to, [...trail, edge]);
      if (found) return found;
    }
    return null;
  };

  if (seed.to === seed.from) return [seed];
  return search(seed.to, [seed]);
}

/**
 * The actionable message §3.4 asks for: it names the cycle, and it names what the
 * requester already holds — because releasing one of those is the action.
 */
export function describeDeadlock(
  cycle: readonly WaitEdge[],
  held: readonly Claim[],
): string {
  const requester = cycle[0]?.from;
  const holds = held
    .filter(
      (claim) =>
        claim.holder.kind === "session" && claim.holder.sessionId === requester,
    )
    .map((claim) => describePath(claim.path));

  const loop = cycle
    .map(
      (edge) =>
        `${edge.from} waits on ${describePath(edge.path)} (held by ${edge.to})`,
    )
    .join("; ");

  const yours =
    holds.length === 0
      ? "you hold nothing to release"
      : `you hold ${holds.join(", ")} — yield one of those to break the cycle`;

  return `granting this would deadlock: ${loop}. ${yours}.`;
}
