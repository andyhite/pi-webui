import { describe, expect, it, vi } from "vitest";

import type { HttpClient } from "../transport/http.js";
import type { MinimalWebSocket, WebSocketFactory } from "../transport/ws.js";
import { createApiAttentionDataSource } from "./data-source.js";
import type { AttentionItem } from "./types.js";

function fakeSocket(): MinimalWebSocket {
  return {
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    send: vi.fn(),
    close: vi.fn(),
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: "attn-1",
    feed: "drift",
    target: { nodeId: "n1", workstreamId: "w1" },
    rank: 500,
    summary: "drifted",
    payload: {
      kind: "drift",
      objectId: "obj-1",
      changedSummary: "changed",
    },
    raisedAt: 0,
    snoozeUntil: null,
    ...overrides,
  };
}

describe("createApiAttentionDataSource", () => {
  it("listOpen bootstraps from GET /api/attention", async () => {
    const get = vi.fn(async () => ({ items: [item()] }));
    const http = { get } as unknown as HttpClient;
    const source = createApiAttentionDataSource({
      http,
      createSocket: vi.fn() as unknown as WebSocketFactory,
    });

    const items = await source.list();

    expect(get).toHaveBeenCalledWith("/api/attention");
    expect(items).toEqual([item()]);
  });

  it("subscribe resyncs over the socket (connect, buffer, snapshot, apply)", async () => {
    const socket = fakeSocket();
    const createSocket: WebSocketFactory = vi.fn(() => socket);
    const get = vi.fn(async () => ({ items: [item({ id: "a" })] }));
    const http = { get } as unknown as HttpClient;

    const source = createApiAttentionDataSource({ http, createSocket });
    const onChange = vi.fn();
    source.subscribe(onChange);
    socket.onopen?.();
    await flush();

    expect(onChange.mock.calls.at(-1)?.[0]).toEqual([item({ id: "a" })]);
  });

  it("applies a buffered attention event once the snapshot lands", async () => {
    const socket = fakeSocket();
    const createSocket: WebSocketFactory = vi.fn(() => socket);
    const get = vi.fn(async () => ({ items: [item({ id: "a" })] }));
    const http = { get } as unknown as HttpClient;

    const source = createApiAttentionDataSource({ http, createSocket });
    const onChange = vi.fn();
    source.subscribe(onChange);
    socket.onopen?.();
    // Arrives before the GET's promise resolves — buffered, not dropped.
    socket.onmessage?.({
      data: JSON.stringify({
        type: "event",
        event: {
          id: "evt1",
          seq: 1,
          occurredAt: 0,
          author: { kind: "human" },
          entity: "attention",
          verb: "created",
          item: item({ id: "b" }),
        },
      }),
    });
    await flush();

    const latest = onChange.mock.calls.at(-1)?.[0] as AttentionItem[];
    expect(latest.map((i) => i.id).sort()).toEqual(["a", "b"]);
  });

  it("a deleted event removes the item from what it emits next", async () => {
    const socket = fakeSocket();
    const createSocket: WebSocketFactory = vi.fn(() => socket);
    const get = vi.fn(async () => ({ items: [item({ id: "a" })] }));
    const http = { get } as unknown as HttpClient;

    const source = createApiAttentionDataSource({ http, createSocket });
    const onChange = vi.fn();
    source.subscribe(onChange);
    socket.onopen?.();
    await flush();

    socket.onmessage?.({
      data: JSON.stringify({
        type: "event",
        event: {
          id: "evt2",
          seq: 2,
          occurredAt: 0,
          author: { kind: "human" },
          entity: "attention",
          verb: "deleted",
          itemId: "a",
          reason: "triaged",
        },
      }),
    });

    expect(onChange.mock.calls.at(-1)?.[0]).toEqual([]);
  });

  it("never emits a transient empty snapshot mid-resync (an event before the snapshot lands is buffered, not lost)", async () => {
    const socket = fakeSocket();
    const createSocket: WebSocketFactory = vi.fn(() => socket);
    let resolveGet: (() => void) | undefined;
    const get = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveGet = () => resolve({ items: [item({ id: "a" })] });
        }),
    );
    const http = { get } as unknown as HttpClient;

    const source = createApiAttentionDataSource({ http, createSocket });
    const onChange = vi.fn();
    source.subscribe(onChange);
    socket.onopen?.();
    // The fetch has not resolved yet — nothing has been emitted at all,
    // never a bare `[]`.
    expect(onChange).not.toHaveBeenCalled();

    resolveGet?.();
    await flush();
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual([item({ id: "a" })]);
  });

  it("redoes the whole resync recipe on reconnect", async () => {
    vi.useFakeTimers();
    try {
      const sockets = [fakeSocket(), fakeSocket()];
      let created = 0;
      const createSocket: WebSocketFactory = vi.fn(() => {
        const next = sockets[created];
        created += 1;
        if (!next) throw new Error("unexpected extra socket");
        return next;
      });
      const get = vi.fn(async () => ({ items: [item()] }));
      const http = { get } as unknown as HttpClient;

      const source = createApiAttentionDataSource({ http, createSocket });
      source.subscribe(vi.fn());
      sockets[0]?.onopen?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(get).toHaveBeenCalledTimes(1);

      sockets[0]?.onclose?.();
      await vi.advanceTimersByTimeAsync(1_000);
      sockets[1]?.onopen?.();
      await vi.advanceTimersByTimeAsync(0);

      expect(get).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("acknowledge/snooze/mute post to the item's own triage endpoint", async () => {
    const post = vi.fn(async () => ({}));
    const http = { post } as unknown as HttpClient;
    const source = createApiAttentionDataSource({
      http,
      createSocket: vi.fn() as unknown as WebSocketFactory,
    });

    await source.acknowledge("attn-1", { at: 0, by: { kind: "human" } });
    expect(post).toHaveBeenCalledWith("/api/attention/attn-1/acknowledge", {});

    await source.snooze("attn-1", {
      at: 0,
      by: { kind: "human" },
      snoozedUntil: 100,
    });
    expect(post).toHaveBeenCalledWith("/api/attention/attn-1/snooze", {
      snoozedUntil: 100,
    });

    await source.mute("attn-1", { at: 0, by: { kind: "human" } });
    expect(post).toHaveBeenCalledWith("/api/attention/attn-1/mute", {});
  });

  it("answerQuestion resolves the attention item id to its questionId, not the option label", async () => {
    const get = vi.fn(async () => ({
      items: [
        item({
          id: "attn-q",
          feed: "question",
          payload: {
            kind: "question",
            questionId: "q-42",
            text: "keep going?",
            options: [{ id: "opt-yes", label: "yes" }],
          },
        }),
      ],
    }));
    const post = vi.fn(async () => ({}));
    const http = { get, post } as unknown as HttpClient;
    const source = createApiAttentionDataSource({
      http,
      createSocket: vi.fn() as unknown as WebSocketFactory,
    });
    await source.list(); // seeds itemsById for the fixture-free live source

    await source.answerQuestion("attn-q", "opt-yes", {
      at: 0,
      by: { kind: "human" },
    });

    expect(post).toHaveBeenCalledWith("/api/questions/q-42/answer", {
      optionId: "opt-yes",
    });
  });

  it("answerQuestion rejects for an id the source has never seen", async () => {
    const http = {
      get: vi.fn(async () => ({ items: [] })),
    } as unknown as HttpClient;
    const source = createApiAttentionDataSource({
      http,
      createSocket: vi.fn() as unknown as WebSocketFactory,
    });

    await expect(
      source.answerQuestion("gone", "opt-yes", {
        at: 0,
        by: { kind: "human" },
      }),
    ).rejects.toThrow();
  });

  it("decideApproval resolves the attention item id to its approvalId, and posts the reason for a deny", async () => {
    const get = vi.fn(async () => ({
      items: [
        item({
          id: "attn-a",
          feed: "approval",
          payload: {
            kind: "approval",
            approvalId: "appr-7",
            capability: "git:force-push",
            answers: [],
            effectFailure: null,
          },
        }),
      ],
    }));
    const post = vi.fn(async () => ({}));
    const http = { get, post } as unknown as HttpClient;
    const source = createApiAttentionDataSource({
      http,
      createSocket: vi.fn() as unknown as WebSocketFactory,
    });
    await source.list();

    await source.decideApproval(
      "attn-a",
      "deny",
      { at: 0, by: { kind: "human" } },
      "not now",
    );

    expect(post).toHaveBeenCalledWith("/api/approvals/appr-7/answer", {
      decision: "deny",
      reason: "not now",
    });
  });

  it("decideApproval omits reason for approve-once", async () => {
    const get = vi.fn(async () => ({
      items: [
        item({
          id: "attn-a",
          feed: "approval",
          payload: {
            kind: "approval",
            approvalId: "appr-7",
            capability: "git:force-push",
            answers: [],
            effectFailure: null,
          },
        }),
      ],
    }));
    const post = vi.fn(async () => ({}));
    const http = { get, post } as unknown as HttpClient;
    const source = createApiAttentionDataSource({
      http,
      createSocket: vi.fn() as unknown as WebSocketFactory,
    });
    await source.list();

    await source.decideApproval("attn-a", "approve-once", {
      at: 0,
      by: { kind: "human" },
    });

    expect(post).toHaveBeenCalledWith("/api/approvals/appr-7/answer", {
      decision: "approve-once",
    });
  });
});
