import { describe, expect, it, vi } from "vitest";
import { humanAuthor } from "@plotroom/core";
import type {
  DomainEvent,
  PlacedNode,
  PlotObject,
  Workstream,
} from "@plotroom/core";

import { createContributionRegistry } from "../plugins/contribution-registry.js";
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
    sessions: [],
  };
}

function rawSnapshotWithWorkstream(
  seq: number,
  workstreamId: string,
): RawSnapshot {
  return {
    ...emptyRawSnapshot(seq),
    workstreams: [
      {
        id: workstreamId as Workstream["id"],
        subjectId: null,
        status: "active",
        archivedAt: null,
        createdAt: 0,
      },
    ],
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

  it("uses a fixture manifest's card renderer for a concept arriving from the server with a matching kind (§10.1)", async () => {
    const object: PlotObject = {
      id: "obj_doc" as PlotObject["id"],
      kind: "document",
      scope: "world",
      workstreamId: null,
      external: { system: "filesystem", id: "/tmp/readme.md" },
      title: "readme.md",
      latestVersionId: "v1" as PlotObject["latestVersionId"],
      createdAt: 0,
      promotedAt: null,
    };
    const node: PlacedNode = {
      id: "n_doc" as PlacedNode["id"],
      role: "content",
      refId: object.id,
      workstreamId: null,
      createdAt: 0,
      deletedAt: null,
    };
    const get = vi.fn(async () => ({
      ...emptyRawSnapshot(1),
      objects: [object],
      nodes: [node],
    }));
    const http = { get } as unknown as HttpClient;
    const createSocket = vi.fn() as unknown as WebSocketFactory;

    const registry = createContributionRegistry();
    registry.registerManifest("filesystem", {
      name: "filesystem",
      version: "0.0.0",
      contractVersion: 0,
      permissions: [],
      cardRenderers: [
        {
          kinds: ["document"],
          renderCard: async (produced) => ({
            title: `file: ${produced.title}`,
            lines: [`kind: ${produced.kind}`],
            actions: [],
          }),
        },
      ],
    });

    const source = createApiGraphDataSource({ http, createSocket, registry });
    const snapshot = await source.load();

    expect(snapshot.nodes).toEqual([
      expect.objectContaining({
        id: "n_doc",
        kind: "document",
        cardView: {
          title: "file: readme.md",
          lines: ["kind: document"],
          actions: [],
        },
      }),
    ]);
  });

  it("leaves cardView unset with an empty registry — today's production default is unaffected", async () => {
    const object: PlotObject = {
      id: "obj_ticket" as PlotObject["id"],
      kind: "ticket",
      scope: "world",
      workstreamId: null,
      external: null,
      title: "a ticket",
      latestVersionId: "v1" as PlotObject["latestVersionId"],
      createdAt: 0,
      promotedAt: null,
    };
    const node: PlacedNode = {
      id: "n_ticket" as PlacedNode["id"],
      role: "content",
      refId: object.id,
      workstreamId: null,
      createdAt: 0,
      deletedAt: null,
    };
    const get = vi.fn(async () => ({
      ...emptyRawSnapshot(1),
      objects: [object],
      nodes: [node],
    }));
    const http = { get } as unknown as HttpClient;
    const createSocket = vi.fn() as unknown as WebSocketFactory;

    const source = createApiGraphDataSource({ http, createSocket });
    const snapshot = await source.load();

    expect(snapshot.nodes[0]?.cardView).toBeUndefined();
    expect(snapshot.nodes[0]?.kind).toBe("ticket");
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

  it("a stale in-flight resync does not clobber state from a newer one (overlapping reconnects)", async () => {
    const socket = fakeSocket();
    const createSocket: WebSocketFactory = vi.fn(() => socket);

    const first = deferred<RawSnapshot>();
    const second = deferred<RawSnapshot>();
    let call = 0;
    const get = vi.fn(async () => {
      call += 1;
      return call === 1 ? first.promise : second.promise;
    });
    const http = { get } as unknown as HttpClient;

    const source = createApiGraphDataSource({ http, createSocket });
    const onSnapshot = vi.fn();
    source.subscribe(onSnapshot);

    // First "open": resync #1 starts, its fetch left pending.
    socket.onopen?.();
    // A second "open" before #1 resolved (a reconnect racing it): resync #2
    // starts and supersedes #1 as `currentBuffer`.
    socket.onopen?.();

    // #2 (the current one) resolves first.
    second.resolve(rawSnapshotWithWorkstream(10, "ws_new"));
    await flush();

    // #1 (stale, superseded) resolves late, with different data. It must
    // be discarded rather than stomping #2's already-settled state.
    first.resolve(rawSnapshotWithWorkstream(3, "ws_old"));
    await flush();

    const last = onSnapshot.mock.calls.at(-1)?.[0];
    expect(last.containers).toEqual([
      expect.objectContaining({ id: "ws_new" }),
    ]);
    expect(last.containers).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "ws_old" })]),
    );
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
