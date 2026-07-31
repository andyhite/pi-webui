/**
 * Worker-thread plugin host with failure isolation (spec §10.2).
 *
 * A plugin that throws, hangs, or fails to load degrades to that plugin being
 * unavailable, with a reported reason — never a crashed host. `PluginHost.load`
 * therefore always resolves: failure is a health state, not an exception. Only
 * calls against an unavailable plugin reject, with `PluginUnavailableError`.
 */
import { Worker } from "node:worker_threads";

import type {
  HostToWorkerMessage,
  WorkerBootData,
  WorkerToHostMessage,
} from "./protocol.js";

export type PluginHealth =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly name: string }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "disposed" };

export class PluginUnavailableError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`plugin unavailable: ${reason}`);
    this.name = "PluginUnavailableError";
    this.reason = reason;
  }
}

export interface PluginHostOptions {
  /** How long the plugin module may take to load before it is declared
   * unavailable. Defaults to 5000ms. */
  readonly loadTimeoutMs?: number;
  /** How long a single call (ping) may take before the plugin is declared
   * unavailable. Defaults to 5000ms. */
  readonly callTimeoutMs?: number;
}

const DEFAULT_LOAD_TIMEOUT_MS = 5_000;
const DEFAULT_CALL_TIMEOUT_MS = 5_000;

/** In tests this module runs straight from `src/`, where the worker entry is
 * a `.ts` file Node executes via type stripping; built output points at the
 * compiled `.js` next to it. */
const workerEntryUrl = (): URL =>
  new URL(
    import.meta.url.endsWith(".ts") ? "./worker-entry.ts" : "./worker-entry.js",
    import.meta.url,
  );

interface PendingCall {
  resolve(payload: string): void;
  reject(error: Error): void;
  readonly timer: NodeJS.Timeout;
}

export class PluginHost {
  #worker: Worker | null = null;
  #health: PluginHealth = { status: "loading" };
  readonly #pending = new Map<number, PendingCall>();
  #nextCallId = 1;
  readonly #callTimeoutMs: number;

  private constructor(callTimeoutMs: number) {
    this.#callTimeoutMs = callTimeoutMs;
  }

  /** Load a plugin module in a fresh worker thread. Always resolves — a
   * plugin that fails to load yields a host whose health is `unavailable`
   * with the reason, per §10.2. */
  static async load(
    moduleUrl: string | URL,
    options: PluginHostOptions = {},
  ): Promise<PluginHost> {
    const host = new PluginHost(
      options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    );
    await host.#start(
      String(moduleUrl),
      options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS,
    );
    return host;
  }

  get health(): PluginHealth {
    return this.#health;
  }

  /** Prove the channel: round-trip a payload through the plugin. Rejects with
   * `PluginUnavailableError` if the plugin is not ready, throws, or hangs —
   * and a throw or hang also degrades the plugin to `unavailable`. */
  async ping(payload: string): Promise<string> {
    const worker = this.#worker;
    if (this.#health.status !== "ready" || worker === null) {
      throw new PluginUnavailableError(this.#currentReason());
    }
    const id = this.#nextCallId++;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fail(`plugin did not answer within ${this.#callTimeoutMs}ms`);
      }, this.#callTimeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      worker.postMessage({
        type: "ping",
        id,
        payload,
      } satisfies HostToWorkerMessage);
    });
  }

  /** Tear the plugin down: ask it to dispose, then terminate the worker.
   * Idempotent; never throws. */
  async dispose(): Promise<void> {
    const worker = this.#worker;
    const previous = this.#health;
    this.#worker = null;
    this.#health = { status: "disposed" };
    this.#rejectPending("plugin disposed");
    if (worker === null) {
      return;
    }
    if (previous.status === "ready") {
      worker.postMessage({ type: "dispose" } satisfies HostToWorkerMessage);
      const exited = new Promise<void>((resolve) => {
        worker.once("exit", () => resolve());
      });
      const timeout = new Promise<void>((resolve) => {
        setTimeout(resolve, this.#callTimeoutMs).unref();
      });
      await Promise.race([exited, timeout]);
    }
    await worker.terminate().catch(() => undefined);
  }

  #start(moduleUrl: string, loadTimeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        this.#fail(`plugin did not load within ${loadTimeoutMs}ms`);
        settle();
      }, loadTimeoutMs);

      let worker: Worker;
      try {
        worker = new Worker(workerEntryUrl(), {
          workerData: { moduleUrl } satisfies WorkerBootData,
          // Do not inherit the parent's CLI flags (test runners register
          // loaders the worker must not depend on).
          execArgv: [],
        });
      } catch (error) {
        this.#fail(`plugin worker could not start: ${describeError(error)}`);
        settle();
        return;
      }
      this.#worker = worker;

      worker.on("message", (message: WorkerToHostMessage) => {
        this.#onMessage(message);
        if (message.type === "loaded" || message.type === "load-failed") {
          settle();
        }
      });
      worker.on("error", (error) => {
        this.#fail(`plugin worker crashed: ${describeError(error)}`);
        settle();
      });
      worker.on("exit", (code) => {
        if (
          this.#health.status === "loading" ||
          this.#health.status === "ready"
        ) {
          this.#fail(`plugin worker exited unexpectedly (code ${code})`);
        }
        settle();
      });
    });
  }

  #onMessage(message: WorkerToHostMessage): void {
    switch (message.type) {
      case "loaded": {
        if (this.#health.status === "loading") {
          this.#health = { status: "ready", name: message.name };
        }
        break;
      }
      case "load-failed": {
        this.#fail(message.reason);
        break;
      }
      case "pong": {
        const call = this.#pending.get(message.id);
        if (call !== undefined) {
          this.#pending.delete(message.id);
          clearTimeout(call.timer);
          call.resolve(message.payload);
        }
        break;
      }
      case "call-failed": {
        this.#fail(`plugin threw: ${message.reason}`);
        break;
      }
    }
  }

  /** Degrade to unavailable-with-reason: the §10.2 failure state. Rejects
   * every in-flight call and terminates the worker. */
  #fail(reason: string): void {
    if (
      this.#health.status === "unavailable" ||
      this.#health.status === "disposed"
    ) {
      return;
    }
    this.#health = { status: "unavailable", reason };
    this.#rejectPending(reason);
    const worker = this.#worker;
    this.#worker = null;
    if (worker !== null) {
      void worker.terminate().catch(() => undefined);
    }
  }

  #rejectPending(reason: string): void {
    for (const call of this.#pending.values()) {
      clearTimeout(call.timer);
      call.reject(new PluginUnavailableError(reason));
    }
    this.#pending.clear();
  }

  #currentReason(): string {
    return this.#health.status === "unavailable"
      ? this.#health.reason
      : `plugin is ${this.#health.status}`;
  }
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
