/**
 * Spawn-or-attach (spec §12, Epic 3.0): on launch, if a server is already
 * listening on the configured port, attach to it; otherwise spawn one and
 * wait for it to become healthy before loading the single origin URL.
 * Shutdown kills only what this process spawned — attaching never touches
 * someone else's process.
 *
 * Pure decision + orchestration, injected with a health probe, a spawn
 * function, and a health-wait strategy, so it is fully unit-testable without
 * a real server, a real child process, or real timers.
 */

export type HealthProbe = () => Promise<boolean>;

export interface SpawnedProcess {
  readonly pid: number;
  /** Resolves once the process has actually exited — never before. */
  kill(): Promise<void>;
}

export type SpawnFn = () => SpawnedProcess;

/** Polls `probe` until it resolves healthy, or the deadline passes. */
export type HealthWaiter = (
  probe: HealthProbe,
  timeoutMs: number,
) => Promise<boolean>;

export interface SpawnOrAttachDeps {
  readonly probe: HealthProbe;
  readonly spawn: SpawnFn;
  readonly waitUntilHealthy: HealthWaiter;
}

export type SpawnOrAttachResult =
  | { readonly mode: "attached" }
  | { readonly mode: "spawned"; readonly pid: number };

export interface SpawnOrAttachHandle {
  readonly result: SpawnOrAttachResult;
  /**
   * Kills only the process this call spawned; a no-op when attached.
   * Fire-and-forget — shutdown does not block on the process actually
   * exiting.
   */
  stop(): void;
}

export class ServerNeverBecameHealthyError extends Error {
  constructor(
    readonly pid: number,
    readonly timeoutMs: number,
  ) {
    super(
      `spawned server (pid ${pid}) never became healthy within ${timeoutMs}ms`,
    );
    this.name = "ServerNeverBecameHealthyError";
  }
}

export async function spawnOrAttach(
  deps: SpawnOrAttachDeps,
  readyTimeoutMs = 10_000,
): Promise<SpawnOrAttachHandle> {
  const alreadyRunning = await deps.probe();
  if (alreadyRunning) {
    return { result: { mode: "attached" }, stop: () => {} };
  }

  const child = deps.spawn();
  const becameHealthy = await deps.waitUntilHealthy(deps.probe, readyTimeoutMs);
  if (becameHealthy) {
    return {
      result: { mode: "spawned", pid: child.pid },
      stop: () => child.kill(),
    };
  }

  // Our own spawn attempt failed to become healthy in time — give up on it
  // and wait for it to actually exit *before* asking again. Only once our
  // child is confirmed gone can a healthy re-probe mean anything other than
  // "our own process, answering a beat late": with the child dead, nothing
  // is left on that port but a genuinely different process (a concurrent
  // launch, or someone starting the server by hand), so attaching to it is
  // correct — never attaching to the corpse of what this call just killed.
  await child.kill();
  const healthyAfterAll = await deps.probe();
  if (healthyAfterAll) {
    return { result: { mode: "attached" }, stop: () => {} };
  }

  throw new ServerNeverBecameHealthyError(child.pid, readyTimeoutMs);
}

/** A fixed-interval poller; `now`/`sleep` are injectable for deterministic tests. */
export function createPollingWaiter(
  intervalMs: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): HealthWaiter {
  return async (probe, timeoutMs) => {
    const deadline = now() + timeoutMs;
    for (;;) {
      if (await probe()) return true;
      if (now() >= deadline) return false;
      await sleep(intervalMs);
    }
  };
}
