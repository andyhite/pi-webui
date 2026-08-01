import { Hono } from "hono";
import { z } from "zod";
import {
  BUDGET_SCOPES,
  endStateFacts,
  exportTranscript,
  systemMillisClock,
  transcriptRenderings,
  type SessionId,
  type VersionId,
} from "@plotroom/core";
import { validateJsonBody } from "../http/validate.js";
import type { RunService } from "../runs/service.js";
import { actorOf, body, param, type ApiEnv, type ApiStores } from "./api.js";

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
      // Derived now, from the log — the stored phase is a snapshot, and a read
      // is a good moment to say what silence has done to the health signal.
      status: stores.sessions.status(id, { now: systemMillisClock() }),
      end:
        stored.session.end === null ? null : endStateFacts(stored.session.end),
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
  app.post("/sessions/:id/end", async (c) => {
    const ended = await service.endOpenSession(param(c, "id"));

    return c.json({
      session: ended.session,
      end: ended.session.end === null ? null : endStateFacts(ended.session.end),
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

    stores.bus.publish({
      entity: "session_transcript",
      verb: "created",
      sessionId: id as SessionId,
      publication: published.publication,
      objectId: published.objectId,
      versionId: published.versionId as VersionId,
      author,
    });

    return c.json({ published });
  });

  return app;
}
