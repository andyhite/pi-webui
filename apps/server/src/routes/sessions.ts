import { Hono } from "hono";
import { z } from "zod";
import {
  BUDGET_SCOPES,
  endedBy,
  endStateFacts,
  exportTranscript,
  sessionTimeline,
  systemMillisClock,
  transcriptRenderings,
} from "@plotroom/core";
import { destroySession } from "../approvals/destruction.js";
import type { ClaimService } from "../claims/service.js";
import { atomically } from "../events/atomic.js";
import { validateJsonBody } from "../http/validate.js";
import type { RunService } from "../runs/service.js";
import { reindexSessionSearch } from "../search/session-index.js";
import {
  announceRestoration,
  announceTranscriptPublished,
} from "./announce.js";
import {
  actorOf,
  body,
  destructionGate,
  param,
  type ApiEnv,
  type ApiStores,
} from "./api.js";

/**
 * Sessions as reads and verbs (§3.6).
 *
 * A session record is readable, resumable, forkable, and deletable *always*, so
 * these reads make no distinction between a live session and a finished one —
 * there is one record, and the phase it reports is derived from its observation
 * log rather than asked of the runtime (principle 7).
 */
const stopBody = z.object({
  mode: z.enum(["graceful", "hard"]).default("graceful"),
  /**
   * `budget` is what Phase 6's enforcer calls through: PlotRoom initiates budget
   * stops, and the end state it produces is out-of-budget — distinct from a
   * stop and from a failure (§3.6, §8).
   */
  cause: z.enum(["user", "budget"]).default("user"),
  scope: z.enum(BUDGET_SCOPES).optional(),
});

export function sessionRoutes(
  stores: ApiStores,
  service: RunService,
  claims: ClaimService,
): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get("/sessions", (c) => {
    const workstreamId = c.req.query("workstreamId");
    const sessions = stores.sessions.list(
      workstreamId === undefined ? {} : { workstreamId },
    );

    return c.json({
      sessions: sessions.map((stored) => ({
        session: stored.session,
        runId: stored.runId,
        workspaceId: stored.workspaceId,
        phase: stored.phase,
        end:
          stored.session.end === null
            ? null
            : endStateFacts(stored.session.end),
      })),
    });
  });

  app.get("/sessions/:id", (c) => {
    const id = param(c, "id");
    const stored = stores.sessions.get(id);

    return c.json({
      session: stored.session,
      runId: stored.runId,
      workspaceId: stored.workspaceId,
      transcriptObjectId: stored.transcriptObjectId,
      planObjectId: stored.planObjectId,
      // Derived now, from the log — the stored phase is a snapshot, and a read
      // is a good moment to say what silence has done to the health signal.
      // PlotRoom's own gates outrank whatever the runtime was last seen doing
      // (§3.6): a session waiting on a path someone else holds is
      // `waiting-on-claim`, and only PlotRoom knows that — no runtime can report
      // it. Derived by the claim manager from the wait rows, so the card and the
      // queue's blocked-on accounting cannot disagree (§7.2).
      status: stores.sessions.status(id, {
        now: systemMillisClock(),
        waitingOnClaim: claims.isWaitingOnClaim(id),
      }),
      end:
        stored.session.end === null ? null : endStateFacts(stored.session.end),
      // Resolved through core, so "an omitted author means the operator" is
      // stated once rather than assumed differently by each surface (§3.6).
      endedBy: stored.session.end === null ? null : endedBy(stored.session.end),
      injections: stores.sessions.injections(id),
    });
  });

  /**
   * PlotRoom's own observation records (decision 0001) — what a streaming
   * transcript renders from, and what phases were derived out of.
   */
  app.get("/sessions/:id/observations", (c) => {
    const id = param(c, "id");
    const since = Number(c.req.query("since") ?? "0");

    return c.json({
      sessionId: id,
      observations: stores.sessions
        .observationRecords(id)
        .filter((record) => record.seq > (Number.isFinite(since) ? since : 0)),
    });
  });

  /**
   * **The session timeline** (§8, §11): "where the time and money went, as a
   * temporal view of turns and tool calls — including for finished sessions, so it
   * is the post-mortem for something that failed overnight."
   *
   * The data behind §11's timeline panel, which is Track B's to render. A
   * projection of the observation log like the transcript, which is exactly why it
   * works for a finished session: nothing is asked of a runtime that is gone
   * (principle 7). The accounting snapshot travels with it, so one read gives both
   * the totals and the shape of how they were reached.
   */
  app.get("/sessions/:id/timeline", (c) => {
    const id = param(c, "id");
    const stored = stores.sessions.get(id);
    const { accounting } = stores.sessions.observationState(id);

    return c.json({
      sessionId: id,
      timeline: sessionTimeline(stores.sessions.observations(id)),
      accounting,
      end:
        stored.session.end === null ? null : endStateFacts(stored.session.end),
    });
  });

  /**
   * The transcript, with its three renderings and its publication history. The
   * export rehydrates released content and reports what it could not, so what
   * leaves the product is the whole session or an honest account of it (§6.1).
   */
  app.get("/sessions/:id/transcript", (c) => {
    const id = param(c, "id");
    const { transcript, completedTurns } = stores.sessions.transcript(id);

    return c.json({
      sessionId: id,
      turns: transcript.turns,
      completedTurns,
      renderings: transcriptRenderings(transcript),
      publications: stores.sessions.publications(id),
      // Nothing has been released yet (§6.1's bound lands with the Conversation
      // panel), so an export is complete; it says so rather than being assumed.
      export: exportTranscript(transcript, () => null),
    });
  });

  /** Stop at the session scope (§6.7). */
  app.post("/sessions/:id/stop", validateJsonBody(stopBody), async (c) => {
    const input = body<z.infer<typeof stopBody>>(c);
    const stopped = await service.stopSession({
      sessionId: param(c, "id"),
      mode: input.mode,
      cause: input.cause,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
    });

    return c.json({
      session: stopped.session,
      end:
        stopped.session.end === null
          ? null
          : endStateFacts(stopped.session.end),
    });
  });

  /** §3.5: an open session ends when the user ends it. */
  /**
   * §3.5: an open session ends when the user ends it — and the record says which
   * user. The attributed actor is the caller's, the same one every other gesture
   * carries, so a card can say "ended by you" or name the session that did it.
   */
  app.post("/sessions/:id/end", async (c) => {
    const ended = await service.endOpenSession(param(c, "id"), actorOf(c));

    return c.json({
      session: ended.session,
      end: ended.session.end === null ? null : endStateFacts(ended.session.end),
      endedBy: ended.session.end === null ? null : endedBy(ended.session.end),
    });
  });

  /**
   * The transcript checkpoint gesture (§3.6): consumers drift here, not per
   * turn. A checkpoint with nothing new publishes nothing, and says so.
   */
  app.post("/sessions/:id/checkpoint", (c) => {
    const id = param(c, "id");
    const author = actorOf(c);
    const published = stores.sessions.publishTranscript(id, {
      kind: "checkpoint",
      at: stores.clock(),
      by: author,
    });

    if (published === null) {
      return c.json({ published: null, reason: "nothing new to publish" });
    }

    // A checkpoint versions the transcript (§3.6); catch the search index up
    // to it, same as session end does.
    reindexSessionSearch(stores, id);
    announceTranscriptPublished(stores.bus, id, published, author);

    return c.json({ published });
  });

  /**
   * Delete a session record (§3.6) — the operator's own gesture; a session's
   * reaches this route only after the §6.6 approval it raises is answered
   * (`destructionGuard`), and lands on the same effect either way.
   *
   * A live session is stopped first and the response says so, because §3.6's
   * "deletable, always" includes one that is running, and a record whose runtime
   * outlived it would be a session nobody can see.
   */
  app.delete("/sessions/:id", async (c) => {
    const id = param(c, "id");
    const outcome = await destroySession(
      stores,
      stores.bus,
      id,
      destructionGate(c),
      async (sessionId) => {
        await service.stopSession({
          sessionId,
          mode: "graceful",
          cause: "user",
        });
      },
    );
    const stored = stores.sessions.get(id);

    return c.json({
      session: stored.session,
      end:
        stored.session.end === null ? null : endStateFacts(stored.session.end),
      /** Whether this gesture stopped a live session on its way (§6.7). */
      stopped: outcome.stopped,
      restorable: true,
    });
  });

  /**
   * Undo one (principle 10): the record, its node, and the wires it had — in one
   * transaction, because a restore that half-landed leaves the same disagreement
   * between board and records that a half-landed removal does.
   */
  app.post("/sessions/:id/restore", (c) => {
    const id = param(c, "id");
    const author = actorOf(c);

    const stored = atomically(stores.db, stores.bus, (announce) => {
      const wasDeleted =
        stores.sessions.get(id).session.deletion.deletedAt !== null;
      const restored = stores.sessions.restore(id);

      if (wasDeleted) {
        // Roots before leaves, the order `announceRestoration` itself follows: the
        // record is back before the node that stands for it, and the node before the
        // wires that need it to exist.
        announce.publish({
          entity: "session",
          verb: "updated",
          session: restored.session,
          status: stores.sessions.status(id, {
            now: systemMillisClock(),
            waitingOnClaim: claims.isWaitingOnClaim(id),
          }),
          author,
        });

        // Only inside this branch: an undo returns what its own removal removed, so
        // a node the operator deleted separately stays deleted (principle 10).
        const placement = stores.graph.findNodeFor("session", id);
        if (placement) {
          announceRestoration(
            announce,
            author,
            stores.graph.restoreNode(placement.id),
          );
        }
      }

      return restored;
    });

    return c.json({
      session: stored.session,
      end:
        stored.session.end === null ? null : endStateFacts(stored.session.end),
    });
  });

  return app;
}
