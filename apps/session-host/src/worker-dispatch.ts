/**
 * The session host is also the agent runtime's worker host, once it is compiled.
 *
 * Under a host Bun the SDK relaunches *its own* `src/cli.ts` for the
 * subprocesses its tools need — the JS eval kernel, the browser broker, the LSP
 * mux. Compiled, that is not available: `isCompiledBinary()` becomes true across
 * the SDK and `resolveWorkerSpawnCmd` re-execs `process.execPath` with a hidden
 * `__omp_worker_*` argv instead. `process.execPath` is this binary, so without
 * this dispatch the child hits `parseSessionHostArgs`, is refused as an unknown
 * argument, and exits 2 — which the spawner does not treat as a reason to fall
 * back, so a pinned tool (`eval`) dies in the compiled artifact while working
 * under a host Bun. Compilation must not change what a session can do.
 *
 * `runCli` is the SDK's own dispatcher, so the selector table stays theirs.
 * Deliberately **not** paired with `declareWorkerHostEntry()`: that would also
 * redirect the SDK's `new Worker(entry, …)` sites into this binary, where today's
 * embedded path leaves them on the SDK's same-realm fallback. Compiled and
 * uncompiled behave the same this way; the dispatch below only restores what
 * compilation took away.
 */

/**
 * `WORKER_HOST_SELECTOR_PREFIX` in `@oh-my-pi/pi-utils/worker-host`, restated
 * because that package is the SDK's dependency and not ours: reaching it would
 * mean declaring `@oh-my-pi/pi-utils` here, and a second exact version pin
 * beside the SDK's is a worse coupling than one string. The compile's smoke test
 * runs a selector against the built binary, so a vendor rename fails the build
 * that produced the artifact rather than the first session that needs a kernel.
 */
export const WORKER_SELECTOR_PREFIX = "__omp_worker_";

/**
 * Run the runtime's worker if this process was launched as one.
 *
 * Returns the exit code to leave with, or `null` when the argv is a session
 * launch and the caller should carry on. Only the first argument selects a
 * worker: a value that merely looks like one (`--model __omp_worker_x`) is a
 * session's argument and must reach the parser that refuses it.
 */
export async function dispatchWorkerSelector(
  argv: readonly string[],
): Promise<number | null> {
  const selector = argv[0];
  if (selector === undefined || !selector.startsWith(WORKER_SELECTOR_PREFIX)) {
    return null;
  }

  // This one specifier must be loaded late, not statically: the SDK's CLI module
  // **launches the agent CLI from its own top level** when it believes it is the
  // process entry, which it does whenever `PI_COMPILED` is set in the
  // environment. Imported statically, an inherited `PI_COMPILED=true` would boot
  // a whole interactive CLI inside every session-host process, including one
  // starting an ordinary session. Behind this guard it can only happen in a
  // process that already is a worker — where the module has then dispatched this
  // argv itself, and calling it again would put two workers on one IPC channel.
  const { runCli } = await import("@oh-my-pi/pi-coding-agent/cli");
  if (process.env.PI_COMPILED !== "true") {
    await runCli([...argv]);
  }
  return process.exitCode === undefined ? 0 : Number(process.exitCode);
}
