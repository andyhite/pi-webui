import { Hono } from "hono";
import { forbidden } from "../http/errors.js";
import { LOG_LEVELS, type LogLevel } from "../logging/logger.js";
import type { LogRingBuffer } from "../logging/ring-buffer.js";
import { actorOf, type ApiEnv } from "./api.js";

/**
 * The structured log, queryable (§8, §11, Epic 8.3): "a Logs panel over the
 * structured log, filtered." `apps/server` has always logged consistent JSON
 * lines to stdout (Epic 2.1); this is the seam Epic 2.1 recorded as deferred
 * — "a persisted structured-log sink (today: stdout JSON lines only)" — filled
 * as a bounded, in-process ring buffer rather than a persisted table: the log
 * is an operational surface for *this run of the process*, not authored state
 * §15 governs, and a restart starting a fresh buffer is the same "this
 * process's own history" the WS event stream's `seq` already means.
 *
 * The operator's own surface, like `/api/log-level`: a session reads its own
 * budget and its own settings elsewhere, but the structured log is the
 * product's operational record, not something a session's own reasoning
 * needs — the same conservative default this batch's settings catalog took.
 */
export function logsRoutes(logs: LogRingBuffer): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.get("/logs", (c) => {
    if (actorOf(c).kind !== "human") {
      throw forbidden(
        "reading the structured log is the operator's control (§8); a session cannot make it",
      );
    }

    const levelParam = c.req.query("level");
    const level =
      levelParam && (LOG_LEVELS as readonly string[]).includes(levelParam)
        ? (levelParam as LogLevel)
        : undefined;
    const component = c.req.query("component");
    const sinceSeqParam = c.req.query("sinceSeq");
    const sinceSeq =
      sinceSeqParam !== undefined && Number.isFinite(Number(sinceSeqParam))
        ? Number(sinceSeqParam)
        : undefined;
    const limitParam = c.req.query("limit");
    const limit =
      limitParam !== undefined && Number.isFinite(Number(limitParam))
        ? Math.max(1, Math.min(1_000, Number(limitParam)))
        : undefined;

    const result = logs.query({
      ...(level ? { level } : {}),
      ...(component ? { component } : {}),
      ...(sinceSeq !== undefined ? { sinceSeq } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });

    return c.json({
      // Flattened back to the same one shape the raw stdout line is (§8's
      // "one consistent shape"), `seq` added: `fields` exists as a separate
      // property internally only so the ring buffer's own filtering never has
      // to guess which keys are reserved.
      entries: result.entries.map(({ fields, ...rest }) => ({
        ...rest,
        ...fields,
      })),
      // Honest about the bound, on every read (cross-cutting rule 5): a
      // client that never saw this drop to zero has missed entries, and this
      // is the number that says so rather than a silent gap in `seq`.
      droppedTotal: result.droppedTotal,
      capacity: result.capacity,
      oldestSeq: result.oldestSeq,
      newestSeq: result.newestSeq,
    });
  });

  return app;
}
