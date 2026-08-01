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
});
