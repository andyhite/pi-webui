import { describe, expect, it } from "bun:test";

import { dispatchWorkerSelector } from "./worker-dispatch.js";

const SESSION_ARGV = [
  "--cwd",
  "/workspaces/one",
  "--session-dir",
  "/state/runtime/session-host",
  "--model",
  "anthropic/claude-haiku-4-5",
  "--effort",
  "medium",
];

describe("dispatchWorkerSelector", () => {
  it("leaves a session launch to the session path", async () => {
    expect(await dispatchWorkerSelector(SESSION_ARGV)).toBeNull();
    expect(await dispatchWorkerSelector([])).toBeNull();
  });

  it("only the first argument selects a worker", async () => {
    // A selector-shaped *value* is a session's argument, and the parser that
    // refuses it must see it: dispatching here would hand the runtime's worker
    // host a launch nobody asked for, on a session that meant to fail.
    expect(
      await dispatchWorkerSelector([
        ...SESSION_ARGV,
        "--model",
        "__omp_worker_js_eval_process",
      ]),
    ).toBeNull();
  });
});
