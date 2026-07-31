/**
 * Worker-thread entry for the plugin host.
 *
 * Runs inside the worker, loads the plugin module named by `workerData`, and
 * speaks the protocol in `protocol.ts`. Every plugin failure is caught and
 * reported as a message — a plugin that throws must degrade to "unavailable,
 * reported", never to a crashed host (§10.2).
 *
 * This file must stay self-contained (type-only local imports), because in
 * tests it is executed straight from `src/` by Node's type stripping, where
 * `./protocol.js` does not exist on disk.
 */
import { parentPort, workerData } from "node:worker_threads";

import type {
  HostToWorkerMessage,
  PluginModule,
  WorkerBootData,
  WorkerToHostMessage,
} from "./protocol.js";

const port = parentPort;
if (port === null) {
  throw new Error("plugin worker entry must run inside a worker thread");
}

const post = (message: WorkerToHostMessage): void => {
  port.postMessage(message);
};

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isPluginModule = (candidate: unknown): candidate is PluginModule =>
  typeof candidate === "object" &&
  candidate !== null &&
  typeof (candidate as { name?: unknown }).name === "string" &&
  typeof (candidate as { ping?: unknown }).ping === "function";

const main = async (): Promise<void> => {
  const { moduleUrl } = workerData as WorkerBootData;

  let plugin: PluginModule;
  try {
    const loaded = (await import(moduleUrl)) as { default?: unknown };
    if (!isPluginModule(loaded.default)) {
      post({
        type: "load-failed",
        reason:
          "module's default export does not implement the plugin contract " +
          "(expected { name: string, ping(payload) })",
      });
      return;
    }
    plugin = loaded.default;
  } catch (error) {
    post({ type: "load-failed", reason: describe(error) });
    return;
  }

  const handle = async (message: HostToWorkerMessage): Promise<void> => {
    switch (message.type) {
      case "dispose": {
        try {
          await plugin.dispose?.();
        } finally {
          process.exit(0);
        }
        break;
      }
      case "ping": {
        try {
          const payload = await plugin.ping(message.payload);
          post({ type: "pong", id: message.id, payload });
        } catch (error) {
          post({
            type: "call-failed",
            id: message.id,
            reason: describe(error),
          });
        }
        break;
      }
    }
  };

  port.on("message", (message: HostToWorkerMessage) => {
    void handle(message);
  });

  post({ type: "loaded", name: plugin.name });
};

void main();
