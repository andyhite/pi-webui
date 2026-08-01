import {
  attributionChainFor,
  checkToolCall,
  planDelegation,
  type Author,
  type CommandId,
  type DelegationPlan,
  type SessionId,
  type ToolTargetIndex,
  type WorkstreamId,
} from "@plotroom/core";
import type { ApiStores } from "../routes/api.js";
import { refused } from "../http/errors.js";

/**
 * Delegation (§3.6, principle 5, Epic 4.5's server half).
 *
 * "There is exactly one way to start [a session], and it is in the app", so a
 * session dispatching a child is `POST /api/runs` with a session actor — not a
 * second verb. **What makes a run a delegation is therefore the actor**, and this
 * module is the two things that follow from one: the lineage check that refuses a
 * run inside the caller's own chain (§4.1), and the provenance edge plus spend
 * attribution that make the child visible and its cost countable.
 *
 * The rules are `@plotroom/core`'s — `checkToolCall`, `planDelegation`,
 * `attributeSpend`. What lives here is the **target resolution** the catalog
 * declares as the mounting contract, because only the graph can answer it.
 */

/**
 * `run_one`'s declared resolution, implemented: "the sessions this command has
 * already run — what a re-run would touch (§4.1). NEVER the session this run is
 * about to create: it is a descendant by construction, and refusing it would
 * refuse delegation itself."
 *
 * The second sentence is the one that matters, and it is why this index is built
 * from *recorded* sessions only. A resolution that reached forward to the session
 * being started would refuse every delegation the spec explicitly permits.
 */
export function createToolTargetIndex(stores: ApiStores): ToolTargetIndex {
  return {
    sessionsAffected(target) {
      switch (target.kind) {
        case "session":
          return [target.id as SessionId];

        case "command":
          return stores.sessions
            .list({ includeDeleted: true })
            .filter((stored) => stored.session.commandId === target.id)
            .map((stored) => stored.session.id);

        case "node": {
          // A node stands for a session directly, or for a command whose sessions
          // it reaches through — "the sessions the target node feeds".
          const node = stores.graph.node(target.id);
          if (node.role === "session") return [node.refId as SessionId];
          if (node.role !== "command") return [];
          return stores.sessions
            .list({ includeDeleted: true })
            .filter((stored) => stored.session.commandId === node.refId)
            .map((stored) => stored.session.id);
        }

        // §3.4's stated exemption: a claim target resolves to the empty set,
        // never the waiting or receiving session, or the parent-to-child grant
        // the claim model is built on would be refused.
        case "claim":
          return [];

        default:
          return [];
      }
    },
  };
}

/**
 * §4.1's lineage rule as the run path's first refusal: "a session cannot run,
 * resume, or re-run itself or anything in its own initiation chain."
 *
 * Called for a session actor only. A human is unconstrained — they are the
 * authority the whole system terminates at (principle 1).
 */
export function checkDelegation(
  stores: ApiStores,
  input: { readonly actor: Author; readonly commandId: string },
): void {
  checkRunGesture(stores, {
    actor: input.actor,
    tool: "run_one",
    commandIds: [input.commandId],
  });
}

/**
 * §4.1's lineage rule for every gesture that runs, re-runs, or resumes work — not
 * only `run_one`.
 *
 * The catalog declares `run_scope`, `run_queue_cancel`, `run_queue_confirm`, and
 * `run_batch_resume` as lineage-checked with a stated target resolution. A
 * declaration nothing calls is the failure cross-cutting rule 3 exists to prevent
 * ("enforced, not documented"), so this is the one function all of them go through,
 * over every command the gesture reaches: confirming or resuming *is* initiating
 * the work, and a session must not use the queue as a way round the rule that
 * refuses it the direct run.
 */
export function checkRunGesture(
  stores: ApiStores,
  input: {
    readonly actor: Author;
    readonly tool: string;
    readonly commandIds: readonly string[];
  },
): void {
  if (input.actor.kind !== "session") return;

  const context = {
    actor: input.actor,
    lineage: stores.graph.lineageIndex(),
    targets: createToolTargetIndex(stores),
  };

  for (const commandId of input.commandIds) {
    const check = checkToolCall(context, {
      tool: input.tool,
      input: { commandId },
      target: { kind: "command", id: commandId },
    });

    if (!check.allowed) {
      // The predicate's own reason and message, unchanged, so the refusal an agent
      // parses is the one the canvas shows (principle 8).
      throw refused({
        reason: check.refusal.reason,
        message: check.refusal.message,
      });
    }
  }
}

/**
 * Record the delegation: a `session_delegated` provenance edge from parent to
 * child, and the attribution chain the child's spend will be charged to.
 *
 * Provenance, never authored (§3.7): the parent did not decide what the child
 * knows by dispatching it, so this edge is recorded automatically and passes
 * through no authoring check.
 */
export function recordDelegation(
  stores: ApiStores,
  input: {
    readonly parent: SessionId;
    readonly childSessionId: string;
    readonly workstreamId: string;
    readonly commandId: string;
    readonly reason: string | null;
  },
): {
  readonly plan: DelegationPlan;
  readonly edgeId: string;
} {
  const plan = planDelegation(stores.graph.lineageIndex(), {
    parentSessionId: input.parent,
    childSessionId: input.childSessionId as SessionId,
    workstreamId: input.workstreamId as WorkstreamId,
    commandId: input.commandId as CommandId,
    reason: input.reason,
    at: stores.clock(),
  });

  const edge = stores.graph.recordProvenance(
    stores.graph.nodeFor("session", input.parent).id,
    stores.graph.nodeFor("session", input.childSessionId).id,
    plan.provenance.relation,
  );

  return { plan, edgeId: edge.id };
}

/**
 * The chain a session's spend is attributed to: itself, then every ancestor up to
 * the human gesture (principle 2). Read from the recorded lineage, so a chain
 * stays answerable after the fact — the same reason run history records what it
 * records (§15-1).
 */
export function attributionChain(
  stores: ApiStores,
  sessionId: string,
): readonly SessionId[] {
  return attributionChainFor(
    stores.graph.lineageIndex(),
    sessionId as SessionId,
  );
}
