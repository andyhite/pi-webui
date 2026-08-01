import { describe, expect, it, vi } from "vitest";

import {
  createReconnectingSocket,
  nextBackoffDelayMs,
  sameOriginWebSocketUrl,
} from "./ws.js";
import type { MinimalWebSocket, WebSocketFactory } from "./ws.js";

describe("nextBackoffDelayMs", () => {
  it("doubles per attempt starting from the minimum", () => {
    expect(nextBackoffDelayMs(0, 100, 10_000)).toBe(100);
    expect(nextBackoffDelayMs(1, 100, 10_000)).toBe(200);
    expect(nextBackoffDelayMs(2, 100, 10_000)).toBe(400);
  });

  it("caps at the maximum", () => {
    expect(nextBackoffDelayMs(10, 100, 10_000)).toBe(10_000);
  });
});

describe("sameOriginWebSocketUrl", () => {
  it("upgrades https to wss and http to ws, using the page's own host", () => {
    expect(
      sameOriginWebSocketUrl("/ws", {
        protocol: "https:",
        host: "example.com:4317",
      }),
    ).toBe("wss://example.com:4317/ws");
    expect(
      sameOriginWebSocketUrl("/ws", {
        protocol: "http:",
        host: "localhost:4317",
      }),
    ).toBe("ws://localhost:4317/ws");
  });
});

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

describe("createReconnectingSocket", () => {
  it("connects immediately and reports open once the socket opens", () => {
    const socket = fakeSocket();
    const createSocket: WebSocketFactory = vi.fn(() => socket);
    const statuses: string[] = [];

    createReconnectingSocket({
      createSocket,
      onMessage: () => {},
      onStatusChange: (status) => statuses.push(status),
    });

    expect(createSocket).toHaveBeenCalledWith("/ws");
    expect(statuses).toEqual(["connecting"]);
    socket.onopen?.();
    expect(statuses).toEqual(["connecting", "open"]);
  });

  it("delivers messages to onMessage", () => {
    const socket = fakeSocket();
    const onMessage = vi.fn();
    createReconnectingSocket({ createSocket: () => socket, onMessage });
    socket.onmessage?.({ data: "hello" });
    expect(onMessage).toHaveBeenCalledWith("hello");
  });

  it("reconnects with backoff on an unexpected close, and resets the attempt count once it reopens", () => {
    const sockets = [fakeSocket(), fakeSocket()];
    let created = 0;
    const createSocket: WebSocketFactory = () => {
      const socket = sockets[created];
      created += 1;
      if (!socket) throw new Error("factory called more times than expected");
      return socket;
    };
    const scheduled: Array<{ fn: () => void; delayMs: number }> = [];

    createReconnectingSocket({
      createSocket,
      onMessage: () => {},
      minBackoffMs: 100,
      maxBackoffMs: 10_000,
      schedule: (fn, delayMs) => scheduled.push({ fn, delayMs }),
    });

    expect(created).toBe(1);
    sockets[0]?.onclose?.();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(100);

    // Running the scheduled reconnect creates the next socket.
    scheduled[0]?.fn();
    expect(created).toBe(2);
    sockets[1]?.onopen?.();

    // A second failure after a successful open starts backoff from zero again.
    sockets[1]?.onclose?.();
    expect(scheduled[1]?.delayMs).toBe(100);
  });

  it("does not reconnect after the caller closes it", () => {
    const socket = fakeSocket();
    const scheduled: Array<() => void> = [];
    const reconnecting = createReconnectingSocket({
      createSocket: () => socket,
      onMessage: () => {},
      schedule: (fn) => scheduled.push(fn),
    });

    reconnecting.close();
    expect(socket.close).toHaveBeenCalled();
    socket.onclose?.();
    expect(scheduled).toHaveLength(0);
  });

  it("send forwards to the current socket", () => {
    const socket = fakeSocket();
    const reconnecting = createReconnectingSocket({
      createSocket: () => socket,
      onMessage: () => {},
    });
    reconnecting.send("ping");
    expect(socket.send).toHaveBeenCalledWith("ping");
  });
});
