/**
 * The WS half of the client transport layer (spec §12's single-origin
 * rule): connects to a same-origin path (`/ws`) — the URL is always built
 * from the page's own `location`, never a literal host or port, so a
 * hardcoded address cannot creep in. Reconnects with capped exponential
 * backoff so a dropped connection (server restart, network blip) recovers
 * without the caller doing anything.
 */

/** The minimal socket surface this module needs — real `WebSocket` satisfies it. */
export interface MinimalWebSocket {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

export type WebSocketFactory = (path: string) => MinimalWebSocket;

/** Capped exponential backoff, pure so the schedule is testable on its own. */
export function nextBackoffDelayMs(
  attempt: number,
  minMs: number,
  maxMs: number,
): number {
  return Math.min(minMs * 2 ** attempt, maxMs);
}

export type SocketStatus = "connecting" | "open" | "closed";

export interface ReconnectingSocketConfig {
  readonly path?: string;
  /** Injectable so tests never open a real socket. */
  readonly createSocket: WebSocketFactory;
  readonly onMessage: (data: unknown) => void;
  readonly onStatusChange?: (status: SocketStatus) => void;
  readonly minBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Injectable so tests control reconnect timing without real timers. */
  readonly schedule?: (fn: () => void, delayMs: number) => void;
}

export interface ReconnectingSocket {
  send(data: string): void;
  close(): void;
}

export function createReconnectingSocket(
  config: ReconnectingSocketConfig,
): ReconnectingSocket {
  const {
    createSocket,
    onMessage,
    onStatusChange,
    minBackoffMs = 500,
    maxBackoffMs = 15_000,
    schedule = (fn, delayMs) => {
      setTimeout(fn, delayMs);
    },
  } = config;
  const path = config.path ?? "/ws";

  let attempt = 0;
  let closedByCaller = false;
  let socket: MinimalWebSocket | null = null;

  function connect(): void {
    onStatusChange?.("connecting");
    const next = createSocket(path);
    socket = next;

    next.onopen = () => {
      attempt = 0;
      onStatusChange?.("open");
    };
    next.onmessage = (event) => onMessage(event.data);
    next.onerror = () => {
      next.close();
    };
    next.onclose = () => {
      onStatusChange?.("closed");
      if (closedByCaller) return;
      const delay = nextBackoffDelayMs(attempt, minBackoffMs, maxBackoffMs);
      attempt += 1;
      schedule(connect, delay);
    };
  }

  connect();

  return {
    send(data) {
      socket?.send(data);
    },
    close() {
      closedByCaller = true;
      socket?.close();
    },
  };
}

/** Same-origin only: built from `location`, never a literal host or port. */
export function sameOriginWebSocketUrl(
  path: string,
  location: { readonly protocol: string; readonly host: string },
): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}${path}`;
}

/** The real browser factory: same-origin `WebSocket`, no default export needed elsewhere. */
export function browserWebSocketFactory(
  location: {
    readonly protocol: string;
    readonly host: string;
  } = window.location,
): WebSocketFactory {
  return (path) =>
    new WebSocket(
      sameOriginWebSocketUrl(path, location),
    ) as unknown as MinimalWebSocket;
}
