import { rmSync } from "node:fs";

/**
 * Removes a test's temporary state directory, retrying through Windows'
 * post-`close()` file-lock window instead of failing on it.
 *
 * Every one of this package's test files opens a state directory, does its
 * work, then in `afterEach` calls `state.close()` immediately followed by
 * `rmSync(dir, { recursive: true, force: true })`. On Linux and macOS an
 * `unlink` of a still-open file succeeds regardless (POSIX semantics), so
 * that ordering never had to matter. On Windows it is not merely slow, it
 * fails outright: `bun:sqlite`'s `Database#close()` (`sqlite3_close_v2`, the
 * only usable option — `close(true)`/`sqlite3_close` throws "database is
 * locked" here, because Drizzle's own prepared-statement cache keeps
 * statements alive by design, so "outstanding" at any given `close()` call is
 * the normal state, not a leak) defers releasing the file handle until every
 * `Statement` this process ever `.prepare()`d is finalized — which happens at
 * GC, not synchronously with `close()` (measured via oven-sh/bun#25964, and
 * directly here: every one of this package's 22 test files failed teardown on
 * `windows-latest` with this exact `EBUSY`/`rm` error, #202's original
 * finding, reproduced fresh under `bun:sqlite` rather than assumed to have
 * moved on from `better-sqlite3`).
 *
 * `Bun.gc(true)` forces the collection pass that finalizes those statements
 * and releases the handle; retrying the removal a bounded number of times
 * with a short synchronous sleep between attempts covers the (rare, but
 * observed) case where a GC pass alone is not enough — the same shape Node's
 * own `fs.rm`/`fs.rmSync` ship as `maxRetries`/`retryDelay` options for
 * exactly this platform behavior, which this driver cannot use directly
 * because they retry the syscall on a timer without ever forcing the GC pass
 * the handle here is actually waiting on.
 */
export function removeStateDir(dir: string): void {
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isTransientWindowsLock(error) || attempt === maxAttempts)
        throw error;
      Bun.gc(true);
      Bun.sleepSync(20 * attempt);
    }
  }
}

function isTransientWindowsLock(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EBUSY" || error.code === "EPERM")
  );
}
