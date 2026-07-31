/**
 * Host ↔ worker protocol for the plugin host (spec §10.2).
 *
 * Deliberately minimal: enough to load a module in a worker_thread, prove the
 * channel with a ping, and tear it down. The full contribution contract
 * (§10.1) freezes in Phase 7 and will extend this surface, not replace the
 * isolation model.
 */

/**
 * What a plugin module must export (as its default export) to be loadable by
 * the host. Minimal for now — `ping` exists to prove the channel end-to-end.
 */
export interface PluginModule {
  readonly name: string;
  ping(payload: string): string | Promise<string>;
  dispose?(): void | Promise<void>;
}

/** Passed to the worker as `workerData`. */
export interface WorkerBootData {
  readonly moduleUrl: string;
}

export type HostToWorkerMessage =
  | { readonly type: "ping"; readonly id: number; readonly payload: string }
  | { readonly type: "dispose" };

export type WorkerToHostMessage =
  | { readonly type: "loaded"; readonly name: string }
  | { readonly type: "load-failed"; readonly reason: string }
  | { readonly type: "pong"; readonly id: number; readonly payload: string }
  | {
      readonly type: "call-failed";
      readonly id: number;
      readonly reason: string;
    };
