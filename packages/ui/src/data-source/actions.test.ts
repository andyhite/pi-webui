import { describe, expect, it, vi } from "vitest";

import { HttpError, type HttpClient } from "../transport/http.js";
import { createApiActions } from "./actions.js";

function fakeHttp(overrides: Record<string, unknown> = {}): HttpClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  } as unknown as HttpClient;
}

describe("createApiActions", () => {
  it("placeNode posts to /api/nodes and returns the created node id", async () => {
    const post = vi.fn(async () => ({ node: { id: "n1" } }));
    const actions = createApiActions(fakeHttp({ post }));

    const result = await actions.placeNode({ role: "content", refId: "obj1" });

    expect(post).toHaveBeenCalledWith("/api/nodes", {
      role: "content",
      refId: "obj1",
    });
    expect(result).toEqual({ ok: true, value: { nodeId: "n1" } });
  });

  it("addContextEdge surfaces a 409 refusal rather than throwing or succeeding", async () => {
    const post = vi.fn(async () => {
      throw new HttpError(409, "/api/edges", {
        error: {
          code: "refused",
          message: "content cannot be wired into content",
          details: { reason: "illegal_target" },
        },
      });
    });
    const actions = createApiActions(fakeHttp({ post }));

    const result = await actions.addContextEdge({ from: "a", to: "b" });

    expect(result).toEqual({
      ok: false,
      refusal: {
        reason: "illegal_target",
        message: "content cannot be wired into content",
      },
    });
  });

  it("lets a non-refusal error (5xx, network) propagate rather than reporting it as a refusal", async () => {
    const post = vi.fn(async () => {
      throw new HttpError(500, "/api/edges", {
        error: { code: "internal_error", message: "internal server error" },
      });
    });
    const actions = createApiActions(fakeHttp({ post }));

    await expect(
      actions.addContextEdge({ from: "a", to: "b" }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("createWorkstream posts an optional subjectId only when given", async () => {
    const post = vi.fn(async () => ({ workstream: { id: "ws1" } }));
    const actions = createApiActions(fakeHttp({ post }));

    await actions.createWorkstream();
    expect(post).toHaveBeenLastCalledWith("/api/workstreams", {});

    await actions.createWorkstream("subj1");
    expect(post).toHaveBeenLastCalledWith("/api/workstreams", {
      subjectId: "subj1",
    });
  });

  it("removeNode/removeEdge encode the id into the path", async () => {
    const del = vi.fn(async () => undefined);
    const actions = createApiActions(fakeHttp({ delete: del }));

    await actions.removeNode("n/1");
    expect(del).toHaveBeenCalledWith("/api/nodes/n%2F1");

    await actions.removeEdge("e 1");
    expect(del).toHaveBeenCalledWith("/api/edges/e%201");
  });

  it("instantiateCommand posts to /api/commands and returns the new command/node ids", async () => {
    const post = vi.fn(async () => ({
      command: { id: "cmd1" },
      node: { id: "n_cmd1" },
    }));
    const actions = createApiActions(fakeHttp({ post }));

    const result = await actions.instantiateCommand({
      definitionId: "def1",
      workstreamId: "ws1",
      context: ["n_ticket"],
    });

    expect(post).toHaveBeenCalledWith("/api/commands", {
      definitionId: "def1",
      workstreamId: "ws1",
      context: ["n_ticket"],
    });
    expect(result).toEqual({
      ok: true,
      value: { commandId: "cmd1", nodeId: "n_cmd1" },
    });
  });

  it("runCommand posts to /api/runs and returns kind: started with the run/session ids", async () => {
    const post = vi.fn(async () => ({
      run: { id: "run1" },
      session: { id: "sess1" },
      queued: null,
    }));
    const actions = createApiActions(fakeHttp({ post }));

    const result = await actions.runCommand({
      commandId: "cmd1",
      initiationKey: "key1",
    });

    expect(post).toHaveBeenCalledWith("/api/runs", {
      commandId: "cmd1",
      initiationKey: "key1",
    });
    expect(result).toEqual({
      ok: true,
      value: { kind: "started", runId: "run1", sessionId: "sess1" },
    });
  });

  it("runCommand reports a 202 admission as kind: queued rather than crashing on a null run/session", async () => {
    const post = vi.fn(async () => ({
      run: null,
      session: null,
      queued: { id: "q1", position: 3 },
    }));
    const actions = createApiActions(fakeHttp({ post }));

    const result = await actions.runCommand({
      commandId: "cmd1",
      initiationKey: "key1",
    });

    expect(result).toEqual({
      ok: true,
      value: { kind: "queued", queueEntryId: "q1", position: 3 },
    });
  });

  it("cancelQueuedRun deletes the queue entry", async () => {
    const del = vi.fn(async () => ({ cancelled: true }));
    const actions = createApiActions(fakeHttp({ delete: del }));

    const result = await actions.cancelQueuedRun("q1");

    expect(del).toHaveBeenCalledWith("/api/run-queue/q1");
    expect(result).toEqual({ ok: true, value: { cancelled: true } });
  });

  it("runCommand surfaces a refusal (e.g. the workspace isn't ready) rather than throwing", async () => {
    const post = vi.fn(async () => {
      throw new HttpError(409, "/api/runs", {
        error: {
          code: "refused",
          message: "no repository is configured to branch from",
          details: { reason: "workspace_not_configured" },
        },
      });
    });
    const actions = createApiActions(fakeHttp({ post }));

    const result = await actions.runCommand({
      commandId: "cmd1",
      initiationKey: "key1",
    });

    expect(result).toEqual({
      ok: false,
      refusal: {
        reason: "workspace_not_configured",
        message: "no repository is configured to branch from",
      },
    });
  });

  it("reorderContext posts the new edge order to /api/nodes/:id/context/order", async () => {
    const post = vi.fn(async () => ({}));
    const actions = createApiActions(fakeHttp({ post }));

    await actions.reorderContext("n/1", ["e1", "e2"]);

    expect(post).toHaveBeenCalledWith("/api/nodes/n%2F1/context/order", {
      edgeIds: ["e1", "e2"],
    });
  });

  it("createNote/editNote hit the notes endpoints", async () => {
    const post = vi.fn(async () => ({ object: { id: "obj1" } }));
    const patch = vi.fn(async () => undefined);
    const actions = createApiActions(fakeHttp({ post, patch }));

    const created = await actions.createNote({ title: "t", body: "b" });
    expect(post).toHaveBeenCalledWith("/api/notes", { title: "t", body: "b" });
    expect(created).toEqual({ ok: true, value: { objectId: "obj1" } });

    await actions.editNote("obj1", { body: "new body" });
    expect(patch).toHaveBeenCalledWith("/api/notes/obj1", { body: "new body" });
  });

  it("checkpointTranscript posts to the session's checkpoint endpoint and returns the publication", async () => {
    const post = vi.fn(async () => ({
      published: { publication: { ordinal: 1, throughTurn: 3 } },
    }));
    const actions = createApiActions(fakeHttp({ post }));

    const result = await actions.checkpointTranscript("sess/1");

    expect(post).toHaveBeenCalledWith("/api/sessions/sess%2F1/checkpoint");
    expect(result).toEqual({
      ok: true,
      value: { publication: { ordinal: 1, throughTurn: 3 } },
    });
  });

  it("checkpointTranscript reports 'nothing new to publish' as a null publication, not a refusal", async () => {
    const post = vi.fn(async () => ({ published: null }));
    const actions = createApiActions(fakeHttp({ post }));

    const result = await actions.checkpointTranscript("sess1");

    expect(result).toEqual({ ok: true, value: { publication: null } });
  });

  it("injectIntoSession posts to the session's inject endpoint", async () => {
    const post = vi.fn(async () => ({
      injectionId: "inj1",
      status: "queued",
      refusedReason: null,
    }));
    const actions = createApiActions(fakeHttp({ post }));

    const result = await actions.injectIntoSession({
      sessionId: "sess/1",
      text: "stop grepping",
      injectionId: "inj1",
    });

    expect(post).toHaveBeenCalledWith("/api/sessions/sess%2F1/inject", {
      text: "stop grepping",
      injectionId: "inj1",
    });
    expect(result).toEqual({
      ok: true,
      value: { injectionId: "inj1", status: "queued", refusedReason: null },
    });
  });

  it("answerQuestion posts to the question's answer endpoint", async () => {
    const post = vi.fn(async () => ({
      question: {},
      answer: {},
      pathsNotTaken: [],
      settled: true,
    }));
    const actions = createApiActions(fakeHttp({ post }));

    const result = await actions.answerQuestion({
      questionId: "q1",
      optionId: "opt-yes",
    });

    expect(post).toHaveBeenCalledWith("/api/questions/q1/answer", {
      optionId: "opt-yes",
    });
    expect(result).toEqual({ ok: true, value: { settled: true } });
  });

  it("previewStop reads GET /api/stops/preview with the scope's own query params, never wrapped in ActionResult", async () => {
    const get = vi.fn(async () => ({
      scope: "workstream",
      sessionIds: ["s1", "s2"],
      count: 2,
      enabled: true,
      requiresConfirmation: false,
      description: "stop 2 sessions in this workstream",
    }));
    const actions = createApiActions(fakeHttp({ get }));

    const preview = await actions.previewStop({
      scope: "workstream",
      workstreamId: "ws1",
    });

    expect(get).toHaveBeenCalledWith(
      "/api/stops/preview?scope=workstream&workstreamId=ws1",
    );
    expect(preview.count).toBe(2);
  });

  it("stopScope posts scope + confirm to /api/stops", async () => {
    const post = vi.fn(async () => ({ stopped: ["s1"] }));
    const actions = createApiActions(fakeHttp({ post }));

    const result = await actions.stopScope({
      scope: "session",
      sessionId: "s1",
      confirm: true,
    });

    expect(post).toHaveBeenCalledWith("/api/stops", {
      scope: "session",
      sessionId: "s1",
      confirm: true,
    });
    expect(result).toEqual({ ok: true, value: { stoppedSessionIds: ["s1"] } });
  });

  it("stopScope surfaces the widest-scope confirmation refusal rather than throwing", async () => {
    const post = vi.fn(async () => {
      throw new HttpError(409, "/api/stops", {
        error: {
          code: "refused",
          message:
            "stop everything running — confirm to stop everything running (§6.7)",
          details: { reason: "confirmation_required" },
        },
      });
    });
    const actions = createApiActions(fakeHttp({ post }));

    const result = await actions.stopScope({ scope: "everything" });

    expect(result).toEqual({
      ok: false,
      refusal: {
        reason: "confirmation_required",
        message:
          "stop everything running — confirm to stop everything running (§6.7)",
      },
    });
  });

  it("resumeSession posts to the session's resume endpoint", async () => {
    const post = vi.fn(async () => ({
      session: { id: "sess1" },
      firstTurnQueued: true,
    }));
    const actions = createApiActions(fakeHttp({ post }));

    const result = await actions.resumeSession({
      sessionId: "sess1",
      initiationKey: "key1",
      firstTurn: "keep going",
    });

    expect(post).toHaveBeenCalledWith("/api/sessions/sess1/resume", {
      initiationKey: "key1",
      firstTurn: "keep going",
    });
    expect(result).toEqual({
      ok: true,
      value: { sessionId: "sess1", firstTurnQueued: true },
    });
  });

  it("forkSession posts to the session's fork endpoint", async () => {
    const post = vi.fn(async () => ({
      session: { id: "sess2" },
      workstreamId: "ws1",
      mode: "native",
    }));
    const actions = createApiActions(fakeHttp({ post }));

    const result = await actions.forkSession({
      sessionId: "sess1",
      turn: 3,
      initiationKey: "key1",
    });

    expect(post).toHaveBeenCalledWith("/api/sessions/sess1/fork", {
      turn: 3,
      initiationKey: "key1",
    });
    expect(result).toEqual({
      ok: true,
      value: { sessionId: "sess2", workstreamId: "ws1", mode: "native" },
    });
  });

  it("writeHandoffBrief posts to the session's handoff-brief endpoint, text omitted when not given", async () => {
    const post = vi.fn(async () => ({
      brief: {
        id: "brief1",
        sourceSessionId: "sess1",
        text: "where I got to",
        origin: "derived",
        state: "drafted",
      },
    }));
    const actions = createApiActions(fakeHttp({ post }));

    const result = await actions.writeHandoffBrief({ sessionId: "sess1" });

    expect(post).toHaveBeenCalledWith("/api/sessions/sess1/handoff-brief", {});
    expect(result).toEqual({
      ok: true,
      value: {
        brief: {
          id: "brief1",
          sourceSessionId: "sess1",
          text: "where I got to",
          origin: "derived",
          state: "drafted",
        },
      },
    });
  });

  it("writeHandoffBrief includes text when the source session drafted its own", async () => {
    const post = vi.fn(async () => ({
      brief: {
        id: "brief1",
        sourceSessionId: "sess1",
        text: "custom draft",
        origin: "session-written",
        state: "drafted",
      },
    }));
    const actions = createApiActions(fakeHttp({ post }));

    await actions.writeHandoffBrief({
      sessionId: "sess1",
      text: "custom draft",
    });

    expect(post).toHaveBeenCalledWith("/api/sessions/sess1/handoff-brief", {
      text: "custom draft",
    });
  });

  it("listHandoffBriefs reads the session's handoff-briefs endpoint, unwrapped (never a refusal)", async () => {
    const get = vi.fn(async () => ({
      briefs: [
        {
          id: "brief1",
          sourceSessionId: "sess1",
          text: "where I got to",
          origin: "derived",
          state: "drafted",
        },
      ],
    }));
    const actions = createApiActions(fakeHttp({ get }));

    const result = await actions.listHandoffBriefs("sess1");

    expect(get).toHaveBeenCalledWith("/api/sessions/sess1/handoff-briefs");
    expect(result.briefs).toHaveLength(1);
  });

  it("reviewHandoffBrief posts to the brief's review endpoint", async () => {
    const post = vi.fn(async () => ({
      brief: {
        id: "brief1",
        sourceSessionId: "sess1",
        text: "where I got to",
        origin: "derived",
        state: "reviewed",
      },
    }));
    const actions = createApiActions(fakeHttp({ post }));

    const result = await actions.reviewHandoffBrief({ briefId: "brief1" });

    expect(post).toHaveBeenCalledWith("/api/handoff-briefs/brief1/review", {});
    expect(result).toEqual({
      ok: true,
      value: {
        brief: {
          id: "brief1",
          sourceSessionId: "sess1",
          text: "where I got to",
          origin: "derived",
          state: "reviewed",
        },
      },
    });
  });

  it("sendHandoff posts to /api/handoffs with the brief, workstream, and initiation key", async () => {
    const post = vi.fn(async () => ({
      session: { id: "sess2" },
      briefNodeId: "node1",
    }));
    const actions = createApiActions(fakeHttp({ post }));

    const result = await actions.sendHandoff({
      briefId: "brief1",
      workstreamId: "ws1",
      initiationKey: "key1",
    });

    expect(post).toHaveBeenCalledWith("/api/handoffs", {
      briefId: "brief1",
      workstreamId: "ws1",
      initiationKey: "key1",
    });
    expect(result).toEqual({
      ok: true,
      value: { sessionId: "sess2", briefNodeId: "node1" },
    });
  });

  it("sendHandoff surfaces a reused-initiation-key refusal rather than throwing", async () => {
    const post = vi.fn(async () => {
      throw new HttpError(409, "/api/handoffs", {
        error: {
          code: "refused",
          message: "this initiation key was already used",
          details: { reason: "initiation_key_reused" },
        },
      });
    });
    const actions = createApiActions(fakeHttp({ post }));

    const result = await actions.sendHandoff({
      briefId: "brief1",
      workstreamId: "ws1",
      initiationKey: "key1",
    });

    expect(result).toEqual({
      ok: false,
      refusal: {
        reason: "initiation_key_reused",
        message: "this initiation key was already used",
      },
    });
  });

  it("getContinuation reads the command's continuation endpoint, unwrapped (a preview never refuses)", async () => {
    const get = vi.fn(async () => ({
      continue: { mode: "continue", available: false, blocks: [] },
      fresh: { mode: "fresh", available: true, blocks: [] },
      comparison: { cheaper: null, basis: "input-tokens", description: "" },
      defaultMode: "fresh",
      recommended: "fresh",
      forcedFresh: true,
      windowFit: {},
    }));
    const actions = createApiActions(fakeHttp({ get }));

    const result = await actions.getContinuation("cmd1");

    expect(get).toHaveBeenCalledWith("/api/commands/cmd1/continuation");
    expect(result.recommended).toBe("fresh");
  });
});
