import { describe, expect, it, vi } from "vitest";
import { humanAuthor } from "@plotroom/core";
import type { DomainEvent, Workstream } from "@plotroom/core";

import type { HttpClient } from "../transport/http.js";
import type { MinimalWebSocket, WebSocketFactory } from "../transport/ws.js";
import { createApiGraphDataSource } from "./api.js";
import type { RawSnapshot } from "./board-state.js";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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

function emptyRawSnapshot(seq: number): RawSnapshot {
  return {
    seq,
    workstreams: [],
    nodes: [],
    edges: [],
    objects: [],
    commandDefinitions: [],
    commands: [],
    outputs: [],
  };
}

const workstream: Workstream = {
  id: "ws_1" as Workstream["id"],
  subjectId: null,
  status: "active",
  archivedAt: null,
  createdAt: 0,
};

function eventMessage(seq: number, workstreamRow: Workstream = workstream) {
  const event: DomainEvent = {
    id: `evt_${seq}` as DomainEvent["id"],
    seq,
    occurredAt: 0,
    author: humanAuthor,
    entity: "workstream",
    verb: "created",
    workstream: workstreamRow,
  };
  return JSON.stringify({ type: "event", event });
}

describe("createApiGraphDataSource.load", () => {
  it("fetches the snapshot once and returns a built graph snapshot, no socket involved", async () => {
    const get = vi.fn(async (path: string) => {
      expect(path).toBe("/api/snapshot");
      return emptyRawSnapshot(3);
    });
    const http = { get } as unknown as HttpClient;
    const createSocket = vi.fn() as unknown as WebSocketFactory;

    const source = createApiGraphDataSource({ http, createSocket });
    const snapshot = await source.load();

    expect(snapshot.nodes).toEqual([]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(createSocket).not.toHaveBeenCalled();
  });
});

describe("createApiGraphDataSource.subscribe", () => {
  it("connects, buffers events until the resync snapshot lands, then applies the rest", async () => {
    const socket = fakeSocket();
    const createSocket: WebSocketFactory = vi.fn(() => socket);
    const get = vi.fn(async (path: string) => {
      expect(path).toBe("/api/snapshot");
      return emptyRawSnapshot(5);
    });
    const http = { get } as unknown as HttpClient;

    const source = createApiGraphDataSource({ http, createSocket });
    const onSnapshot = vi.fn();
    source.subscribe(onSnapshot);

    expect(createSocket).toHaveBeenCalledTimes(1);
    socket.onopen?.();

    // A message arrives while the resync snapshot fetch (seq 5) is still
    // pending — it must be buffered, not dropped or misapplied.
    socket.onmessage?.({ data: eventMessage(6) });

    await flush();

    expect(onSnapshot).toHaveBeenCalled();
    const last = onSnapshot.mock.calls.at(-1)?.[0];
    expect(last.containers).toEqual([expect.objectContaining({ id: "ws_1" })]);
  });

  it("drops a buffered event with seq <= the resync snapshot's seq (already reflected)", async () => {
    const socket = fakeSocket();
    const createSocket: WebSocketFactory = vi.fn(() => socket);
    const get = vi.fn(async () => emptyRawSnapshot(10));
    const http = { get } as unknown as HttpClient;

    const source = createApiGraphDataSource({ http, createSocket });
    const onSnapshot = vi.fn();
    source.subscribe(onSnapshot);
    socket.onopen?.();
    // seq 10 <= snapshot.seq (10): already reflected, must not double-apply.
    socket.onmessage?.({ data: eventMessage(10) });
    await flush();

    const last = onSnapshot.mock.calls.at(-1)?.[0];
    expect(last.containers).toEqual([]);
  });

  it("applies a live event that arrives after the initial resync completed", async () => {
    const socket = fakeSocket();
    const createSocket: WebSocketFactory = vi.fn(() => socket);
    const get = vi.fn(async () => emptyRawSnapshot(1));
    const http = { get } as unknown as HttpClient;

    const source = createApiGraphDataSource({ http, createSocket });
    const onSnapshot = vi.fn();
    source.subscribe(onSnapshot);
    socket.onopen?.();
    await flush();
    onSnapshot.mockClear();

    socket.onmessage?.({ data: eventMessage(2) });
    await flush();

    expect(onSnapshot).toHaveBeenCalledTimes(1);
    const snapshot = onSnapshot.mock.calls[0]?.[0];
    expect(snapshot.containers).toEqual([
      expect.objectContaining({ id: "ws_1" }),
    ]);
  });

  it("redoes the whole resync recipe from a fresh snapshot on reconnect", async () => {
    vi.useFakeTimers();
    try {
      let seq = 1;
      const sockets = [fakeSocket(), fakeSocket()];
      let created = 0;
      const createSocket: WebSocketFactory = vi.fn(() => {
        const next = sockets[created];
        created += 1;
        if (!next) throw new Error("unexpected extra socket");
        return next;
      });
      const get = vi.fn(async () => emptyRawSnapshot(seq));
      const http = { get } as unknown as HttpClient;

      const source = createApiGraphDataSource({ http, createSocket });
      source.subscribe(vi.fn());
      sockets[0]?.onopen?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(get).toHaveBeenCalledTimes(1);

      // Reconnect: bump the server's seq to simulate time passing, then
      // simulate the underlying socket dropping and reconnecting (real
      // backoff timing, advanced under fake timers rather than waited out).
      seq = 7;
      sockets[0]?.onclose?.();
      await vi.advanceTimersByTimeAsync(1_000);
      sockets[1]?.onopen?.();
      await vi.advanceTimersByTimeAsync(0);

      expect(get).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the socket once the last subscriber unsubscribes", async () => {
    const socket = fakeSocket();
    const createSocket: WebSocketFactory = vi.fn(() => socket);
    const http = {
      get: vi.fn(async () => emptyRawSnapshot(0)),
    } as unknown as HttpClient;

    const source = createApiGraphDataSource({ http, createSocket });
    const unsubscribe = source.subscribe(vi.fn());
    socket.onopen?.();
    await flush();

    unsubscribe();
    expect(socket.close).toHaveBeenCalled();
  });

  it("hands a later subscriber the current snapshot immediately once already synced", async () => {
    const socket = fakeSocket();
    const createSocket: WebSocketFactory = vi.fn(() => socket);
    const http = {
      get: vi.fn(async () => emptyRawSnapshot(1)),
    } as unknown as HttpClient;

    const source = createApiGraphDataSource({ http, createSocket });
    source.subscribe(vi.fn());
    socket.onopen?.();
    await flush();

    const second = vi.fn();
    source.subscribe(second);
    await flush();

    expect(second).toHaveBeenCalledTimes(1);
  });
});
