/**
 * `SettingsDataSource` (§11, §8, Epic 8.3). `createApiSettingsDataSource` is
 * live over `GET`/`PUT`/`DELETE /api/settings(/:key)` plus the `setting`
 * `/ws` entity. Every verb is `humanOnly` server-side; the browser's own
 * calls are the operator by the actor header's default, so nothing here
 * has to enforce that a second time.
 */

import type { DomainEvent } from "@plotroom/core";

import type { Unsubscribe } from "../data-source/types.js";
import { parseWsMessage } from "../data-source/api.js";
import type { HttpClient } from "../transport/http.js";
import type { WebSocketFactory } from "../transport/ws.js";
import { createReconnectingSocket } from "../transport/ws.js";
import type {
  SettingChangeNotice,
  SettingRow,
  SettingsDataSource,
} from "./types.js";

export interface ApiSettingsDataSourceOptions {
  readonly http: HttpClient;
  readonly createSocket: WebSocketFactory;
}

export function createApiSettingsDataSource(
  options: ApiSettingsDataSourceOptions,
): SettingsDataSource {
  const { http, createSocket } = options;

  let socket: ReturnType<typeof createReconnectingSocket> | null = null;
  const listeners = new Set<(notice: SettingChangeNotice) => void>();

  function ensureStarted(): void {
    if (socket) return;
    socket = createReconnectingSocket({
      createSocket,
      onMessage: (data) => {
        const message = parseWsMessage(data);
        if (!message || message.type !== "event") return;
        const event = message.event as DomainEvent;
        if (event.entity !== "setting") return;
        for (const listener of listeners) listener(event.setting);
      },
    });
  }

  return {
    list(q?: string): Promise<readonly SettingRow[]> {
      const path = q
        ? `/api/settings?q=${encodeURIComponent(q)}`
        : "/api/settings";
      return http
        .get<{ settings: readonly SettingRow[] }>(path)
        .then((response) => response.settings);
    },

    get(key: string): Promise<SettingRow> {
      return http
        .get<{ setting: SettingRow }>(
          `/api/settings/${encodeURIComponent(key)}`,
        )
        .then((response) => response.setting);
    },

    set(key: string, value: unknown): Promise<SettingRow> {
      return http
        .put<{ setting: SettingRow }>(
          `/api/settings/${encodeURIComponent(key)}`,
          { value },
        )
        .then((response) => response.setting);
    },

    remove(key: string): Promise<SettingRow> {
      return http
        .delete<{ setting: SettingRow }>(
          `/api/settings/${encodeURIComponent(key)}`,
        )
        .then((response) => response.setting);
    },

    subscribe(onChange): Unsubscribe {
      listeners.add(onChange);
      ensureStarted();
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0) {
          socket?.close();
          socket = null;
        }
      };
    },
  };
}

/** Fixtures/tests/dev-offline: an in-memory catalog behind the identical interface. */
export function createFixtureSettingsDataSource(
  initial: readonly SettingRow[],
): SettingsDataSource {
  let rows = new Map(initial.map((row) => [row.key, row]));

  function requireRow(key: string): SettingRow {
    const row = rows.get(key);
    if (!row) throw new Error(`no fixture setting named "${key}"`);
    return row;
  }

  return {
    list(q?: string): Promise<readonly SettingRow[]> {
      const all = [...rows.values()];
      if (!q) return Promise.resolve(all);
      const needle = q.toLowerCase();
      return Promise.resolve(
        all.filter(
          (row) =>
            row.key.toLowerCase().includes(needle) ||
            row.label.toLowerCase().includes(needle) ||
            row.description.toLowerCase().includes(needle) ||
            row.group.toLowerCase().includes(needle),
        ),
      );
    },
    get(key: string): Promise<SettingRow> {
      return Promise.resolve(requireRow(key));
    },
    set(key: string, value: unknown): Promise<SettingRow> {
      const current = requireRow(key);
      const next: SettingRow = { ...current, value, overridden: true };
      rows = new Map(rows).set(key, next);
      return Promise.resolve(next);
    },
    remove(key: string): Promise<SettingRow> {
      const current = requireRow(key);
      const next: SettingRow = {
        ...current,
        value: current.defaultValue,
        overridden: false,
      };
      rows = new Map(rows).set(key, next);
      return Promise.resolve(next);
    },
    subscribe(): Unsubscribe {
      // Fixtures never change from outside; nothing to notify.
      return () => {};
    },
  };
}
