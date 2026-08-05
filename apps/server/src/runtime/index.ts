import { readFileSync } from "node:fs";
import { systemMillisClock } from "@plotroom/core";
import type { ServerConfig } from "../config.js";
import type { Logger } from "../logging/logger.js";
import { createOmpRuntime, OMP_ADAPTER_ID } from "./omp.js";
import { createPiRuntime } from "./pi.js";
import { RuntimeRegistry } from "./registry.js";
import {
  createScriptedRuntime,
  runtimeScriptSchema,
  SCRIPTED_ADAPTER_ID,
  type RuntimeScript,
} from "./scripted.js";

export { createOmpRuntime, OMP_ADAPTER_ID } from "./omp.js";
export { RuntimeRegistry } from "./registry.js";
export type { RuntimeLaunch } from "./registry.js";
export {
  createScriptedRuntime,
  isScriptedRuntime,
  parseSubmission,
  runtimeScriptSchema,
  PLOTROOM_SUBMIT_TOOL,
  SCRIPTED_ADAPTER_ID,
} from "./scripted.js";
export type { RuntimeScript, ScriptedSubmission } from "./scripted.js";

/**
 * Which runtimes this installation has (decision 0001).
 *
 * The pi coding agent is adapter v1 and is always available. Two others are
 * registered **only** when the operator selects them, for different reasons.
 *
 * The scripted runtime is opt-in because a client-supplied script would
 * otherwise be a way to fake work in a real installation: with
 * `PLOTROOM_RUNTIME` unset there is no such adapter to name.
 *
 * The session host (issue #73) is opt-in while it is still catching up to pi's
 * feature set. Its permission gate (issue #81) is wired and asserted at boot
 * (`OMP_CAPABILITIES.enforcesPermissions` is true, and the sidecar refuses to
 * accept a prompt until its own gate handler denies a synthetic call), so a
 * session on it runs gated exactly like one on pi.
 */
export function createRuntimeRegistry(
  config: ServerConfig,
  logger: Logger,
): RuntimeRegistry {
  const registry = new RuntimeRegistry();

  if (config.runtime.adapterId === SCRIPTED_ADAPTER_ID) {
    const defaultScript = readScript(config.runtime.scriptPath);
    registry.register(
      createScriptedRuntime({
        now: systemMillisClock,
        ...(defaultScript === null ? {} : { defaultScript }),
      }),
      { default: true },
    );
    logger.info("scripted session runtime selected", {
      scriptPath: config.runtime.scriptPath,
    });
    return registry;
  }

  if (config.runtime.adapterId === OMP_ADAPTER_ID) {
    registry.register(
      createOmpRuntime({
        stateDir: config.stateDir,
        program: config.runtime.sessionHostProgram,
        bunProgram: config.runtime.sessionHostBun,
        logger,
      }),
      { default: true },
    );
    logger.info("session-host runtime selected", {
      program: config.runtime.sessionHostProgram,
    });
    return registry;
  }

  registry.register(
    createPiRuntime({
      stateDir: config.stateDir,
      program: config.runtime.piProgram,
      logger,
    }),
    { default: true },
  );

  return registry;
}

/**
 * A configured script that cannot be read or does not parse is a startup
 * failure, not a silently empty script: a session that ran with no observations
 * would look like a hung one (principle 12 — nothing degrades quietly).
 */
function readScript(path: string | null): RuntimeScript | null {
  if (path === null) return null;
  const parsed = runtimeScriptSchema.safeParse(
    JSON.parse(readFileSync(path, "utf8")),
  );
  if (!parsed.success) {
    throw new Error(
      `PLOTROOM_RUNTIME_SCRIPT at ${path} is not a valid runtime script: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}
