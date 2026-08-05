/**
 * Spawn-or-attach (spec §12, Epic 3.0): on launch, if a server is already
 * listening on the configured port, attach to it; otherwise spawn one and
 * wait for it to become healthy before loading the single origin URL.
 * Shutdown kills only what this process spawned — attaching never touches
 * someone else's process.
 *
 * Pure decision + orchestration, injected with a health-probe factory, a
 * spawn function, and a health-wait strategy, so it is fully unit-testable
 * without a real server, a real child process, or real timers.
 */

export type HealthProbe = () => Promise<boolean>;

/** Builds a probe bound to a specific port — never a single fixed probe. */
export type ProbeFactory = (port: number) => HealthProbe;

export interface SpawnedProcess {
  readonly pid: number;
  /**
   * Resolves with the address the spawned server actually bound. Never the
   * one it was asked for: a stored `host`/`port` override can win at boot
   * (#87), so the port this resolves with is the only one worth probing or
   * connecting to (#88). Rejects if the process exits before ever reporting
   * one.
   */
  readonly listening: Promise<{ readonly host: string; readonly port: number }>;
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
  /** The port to check for an already-running server before ever spawning. */
  readonly port: number;
  readonly probeFor: ProbeFactory;
  readonly spawn: SpawnFn;
  readonly waitUntilHealthy: HealthWaiter;
}

export type SpawnOrAttachResult =
  | { readonly mode: "attached"; readonly port: number }
  | { readonly mode: "spawned"; readonly pid: number; readonly port: number };

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

/**
 * The spawned process exited, or never said, before reporting the address it
 * bound — nothing to health-probe, and nothing this call caused: the child's
 * own exit handler is what already told the caller why.
 */
export class ServerNeverReportedItsAddressError extends Error {
  constructor(readonly pid: number) {
    super(
      `spawned server (pid ${pid}) exited before reporting the address it bound`,
    );
    this.name = "ServerNeverReportedItsAddressError";
  }
}

export async function spawnOrAttach(
  deps: SpawnOrAttachDeps,
  readyTimeoutMs = 10_000,
): Promise<SpawnOrAttachHandle> {
  const attachProbe = deps.probeFor(deps.port);
  const alreadyRunning = await attachProbe();
  if (alreadyRunning) {
    return { result: { mode: "attached", port: deps.port }, stop: () => {} };
  }

  const child = deps.spawn();
  const bound = await child.listening.catch(() => null);
  if (bound === null) {
    throw new ServerNeverReportedItsAddressError(child.pid);
  }

  // The port to health-probe is whichever one the child actually bound, not
  // the one it was asked for (#87's own stored override can move it) — a
  // waiter built from the original `attachProbe` would poll a port nothing
  // is listening on and time out against a server that is, in fact, healthy.
  const probe = deps.probeFor(bound.port);
  const becameHealthy = await deps.waitUntilHealthy(probe, readyTimeoutMs);
  if (becameHealthy) {
    return {
      result: { mode: "spawned", pid: child.pid, port: bound.port },
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
  // The re-probe is against `deps.port`, not `bound.port`: a genuinely
  // different process is the one this launch originally asked for, not
  // whatever address our own corpse happened to report.
  await child.kill();
  const healthyAfterAll = await attachProbe();
  if (healthyAfterAll) {
    return { result: { mode: "attached", port: deps.port }, stop: () => {} };
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
