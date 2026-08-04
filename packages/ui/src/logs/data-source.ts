/**
 * `LogsDataSource` (§8, §11, Epic 8.3). `createApiLogsDataSource` is live
 * over `GET /api/logs` plus the `log` `/ws` entity's drop notice (there is
 * deliberately no per-line event — a live tail is a bounded, sinceSeq-scoped
 * `query()` call the panel makes on its own visible follow toggle, never a
 * timer this module starts on its own).
 */

import type { DomainEvent } from "@plotroom/core";

import type { Unsubscribe } from "../data-source/types.js";
import { parseWsMessage } from "../data-source/api.js";
import type { HttpClient } from "../transport/http.js";
import type { WebSocketFactory } from "../transport/ws.js";
import { createReconnectingSocket } from "../transport/ws.js";
import type {
  LogDropNoticeLike,
  LogsDataSource,
  LogsQuery,
  LogsResult,
} from "./types.js";

export interface ApiLogsDataSourceOptions {
  readonly http: HttpClient;
  readonly createSocket: WebSocketFactory;
}

export function createApiLogsDataSource(
  options: ApiLogsDataSourceOptions,
): LogsDataSource {
  const { http, createSocket } = options;

  let socket: ReturnType<typeof createReconnectingSocket> | null = null;
  const listeners = new Set<(drop: LogDropNoticeLike) => void>();

  function ensureStarted(): void {
    if (socket) return;
    socket = createReconnectingSocket({
      createSocket,
      onMessage: (data) => {
        const message = parseWsMessage(data);
        if (!message || message.type !== "event") return;
        const event = message.event as DomainEvent;
        if (event.entity !== "log") return;
        for (const listener of listeners) listener(event.drop);
      },
    });
  }

  return {
    query(query: LogsQuery): Promise<LogsResult> {
      const params = new URLSearchParams();
      if (query.level) params.set("level", query.level);
      if (query.component) params.set("component", query.component);
      if (query.sinceSeq !== undefined) {
        params.set("sinceSeq", String(query.sinceSeq));
      }
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      const search = params.toString();
      return http.get<LogsResult>(`/api/logs${search ? `?${search}` : ""}`);
    },

    subscribeDrop(onDrop): Unsubscribe {
      listeners.add(onDrop);
      ensureStarted();
      return () => {
        listeners.delete(onDrop);
        if (listeners.size === 0) {
          socket?.close();
          socket = null;
        }
      };
    },
  };
}

/** Fixtures/tests/dev-offline: a static page behind the identical interface. */
export function createFixtureLogsDataSource(
  result: LogsResult,
): LogsDataSource {
  return {
    query(): Promise<LogsResult> {
      return Promise.resolve(result);
    },
    subscribeDrop(): Unsubscribe {
      return () => {};
    },
  };
}
