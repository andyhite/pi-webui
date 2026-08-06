import type { Hono } from "hono";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import type { DomainEvent } from "@plotroom/core";
import type { EventBus, Unsubscribe } from "../events/bus.js";
import type { Logger } from "../logging/logger.js";

/**
 * The wire envelope for `/ws` (Epic 2.1). `hello` is the only control
 * message — it tells a fresh connection the sequence numbering it is
 * joining mid-stream, so a client can detect "I missed events" without this
 * epic having to implement replay (Epic 2.2 or later: a REST snapshot plus
 * this number is how a client would resync). Every other message is one
 * `DomainEvent` from the one vocabulary in `@plotroom/core`.
 */
export type WsServerMessage =
  | {
      readonly type: "hello";
      readonly nextSeq: number;
      readonly serverTime: number;
    }
  | { readonly type: "event"; readonly event: DomainEvent };

export interface MountWsOptions {
  readonly app: Hono;
  readonly path: string;
  readonly upgradeWebSocket: UpgradeWebSocket;
  readonly bus: EventBus;
  readonly logger: Logger;
}

/**
 * Mounts the state-change stream. Origin/credential checks run as ordinary
 * middleware ahead of this route (see `buildApp`) — refused there, this
 * handler never sees the connection.
 */
export function mountWsRoute(options: MountWsOptions): void {
  const { app, path, upgradeWebSocket, bus, logger } = options;

  app.get(
    path,
    upgradeWebSocket(() => {
      let unsubscribe: Unsubscribe | undefined;

      return {
        onOpen: (_event, ws: WSContext) => {
          const hello: WsServerMessage = {
            type: "hello",
            nextSeq: bus.nextSeq,
            serverTime: Date.now(),
          };
          ws.send(JSON.stringify(hello));

          unsubscribe = bus.subscribe((event) => {
            const message: WsServerMessage = { type: "event", event };
            ws.send(JSON.stringify(message));
          });
        },
        onClose: () => {
          unsubscribe?.();
        },
        onError: (err) => {
          logger.warn("ws connection error", {
            err: err instanceof Error ? err.message : JSON.stringify(err),
          });
          unsubscribe?.();
        },
      };
    }),
  );
}
