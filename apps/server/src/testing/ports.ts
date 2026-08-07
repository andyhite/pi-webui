import { createServer } from "node:net";

/**
 * A port the OS says is free, rather than one this module guessed — for the
 * few callers that need a port *before* something binds it (a webhook
 * receiver of their own, an assertion about a configured port, or a child
 * process that has to be told a port before it can report one of its own).
 *
 * Per-worker bands were a previous answer and they were not enough: a band
 * is still a static range, so a leaked server from an earlier run, another
 * suite's harness, or anything else on the machine can already hold a port
 * in it — and the failure is not always a clean `EADDRINUSE`. It can be
 * requests landing on *the other server*, which surfaces as an unrelated
 * refusal somewhere far away.
 *
 * Binding a throwaway socket to port 0 and reading back what the OS assigned
 * cannot collide with anything already listening, leaked or not. It does
 * **not** close the window between this probe's socket closing and whatever
 * binds the port next — a concurrent caller (this function again, or
 * anything else asking the OS for port 0 at the same instant) can still take
 * it first. Anything that binds inside the same process should skip this
 * function and ask the OS directly instead — `startServer(...).listening`
 * (`./harness.js`) reads back what a real bind actually got, atomically, with
 * no such window. This exists for callers that cannot do that, chiefly a
 * child process spawned with a port chosen up front: the environment path a
 * server reads its port from deliberately refuses `0`
 * (`apps/server/src/config.ts`'s `PORT_BOUND`), so a spawned child cannot be
 * asked to self-select the way an in-process caller can, and this probe is
 * what stands in for that instead.
 */
export function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() =>
          reject(new Error("could not determine an ephemeral port")),
        );
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}
