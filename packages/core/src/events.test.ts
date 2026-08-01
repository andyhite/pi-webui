import { describe, expect, it } from "vitest";
import { humanAuthor } from "./author.js";
import { isEventFor, type DomainEvent } from "./events.js";
import {
  newEventId,
  newWorkstreamId,
  type RunId,
  type SessionId,
} from "./ids.js";
import {
  startSession,
  INHERIT_APP_TOOLS,
  type Session,
} from "./sessions/index.js";

function makeSession(id: SessionId): Session {
  return startSession(
    {
      id,
      workstreamId: newWorkstreamId(),
      commandId: null,
      mode: "open",
      launch: {
        model: "fixture-model",
        effort: "medium",
        toolPermissions: INHERIT_APP_TOOLS,
      },
      initiatedBy: humanAuthor,
      runtime: { adapterId: "scripted", ref: "native-1" },
    },
    0,
  );
}

describe("event vocabulary (Epic 2.1, principle 8)", () => {
  it("carries the full entity on created/updated, so a subscriber never diffs", () => {
    const workstreamId = newWorkstreamId();
    const event: DomainEvent = {
      id: newEventId(),
      seq: 1,
      occurredAt: 0,
      author: humanAuthor,
      entity: "workstream",
      verb: "created",
      workstream: {
        id: workstreamId,
        subjectId: null,
        status: "active",
        archivedAt: null,
        createdAt: 0,
      },
    };

    expect(event.workstream.id).toBe(workstreamId);
  });

  it("carries only the id on delete, since the entity no longer exists", () => {
    const workstreamId = newWorkstreamId();
    const event: DomainEvent = {
      id: newEventId(),
      seq: 2,
      occurredAt: 0,
      author: humanAuthor,
      entity: "workstream",
      verb: "deleted",
      workstreamId,
    };

    expect(event.workstreamId).toBe(workstreamId);
  });

  it("narrows by entity kind with isEventFor", () => {
    const event: DomainEvent = {
      id: newEventId(),
      seq: 3,
      occurredAt: 0,
      author: humanAuthor,
      entity: "workstream",
      verb: "deleted",
      workstreamId: newWorkstreamId(),
    };

    expect(isEventFor(event, "workstream")).toBe(true);
    if (isEventFor(event, "workstream")) {
      expect(event.workstreamId).toBeDefined();
    }
    expect(isEventFor(event, "run")).toBe(false);
  });

  it("assigns each event a monotonically distinguishable sequence number", () => {
    const runId = "run_1" as RunId;
    const events: DomainEvent[] = [1, 2, 3].map((seq) => ({
      id: newEventId(),
      seq,
      occurredAt: 0,
      author: humanAuthor,
      entity: "run",
      verb: "deleted",
      runId,
    }));

    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
  });

  it("carries a session's derived status beside the record, never a claim", () => {
    const sessionId = "sess_1" as SessionId;
    const event: DomainEvent = {
      id: newEventId(),
      seq: 4,
      occurredAt: 0,
      author: humanAuthor,
      entity: "session",
      verb: "updated",
      session: makeSession(sessionId),
      status: {
        phase: { kind: "tool-running", toolName: "write_file" },
        facts: { busy: true, wantsAttention: false },
        health: { silentForMs: 0, possiblyStalled: false },
      },
    };

    // The phase is derived by PlotRoom (principle 7), so it travels with the
    // record rather than being something a subscriber folds the log to find.
    expect(event.status.phase).toEqual({
      kind: "tool-running",
      toolName: "write_file",
    });
    expect(event.session.id).toBe(sessionId);
  });

  it("stamps observation records per session, so applying one twice is a no-op", () => {
    const sessionId = "sess_1" as SessionId;
    const event: DomainEvent = {
      id: newEventId(),
      seq: 5,
      occurredAt: 0,
      author: humanAuthor,
      entity: "session_observation",
      verb: "created",
      sessionId,
      seqInSession: 7,
      observation: { kind: "output-delta", text: "hello", at: 1_000 },
    };

    expect(isEventFor(event, "session_observation")).toBe(true);
    if (isEventFor(event, "session_observation")) {
      expect(event.seqInSession).toBe(7);
      expect(event.observation.kind).toBe("output-delta");
    }
  });
});
