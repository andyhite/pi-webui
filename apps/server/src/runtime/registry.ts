import type {
  RuntimeStartConfig,
  SessionRuntimeAdapter,
  RuntimeSessionHandle,
} from "@plotroom/core";
import { checkPermissionEnforcement } from "@plotroom/core";
import { refused } from "../http/errors.js";
import { isScriptedRuntime, type RuntimeScript } from "./scripted.js";

/**
 * The adapter registry over `@plotroom/core`'s runtime seam (decision 0001).
 *
 * PlotRoom owns the interface; an adapter supplies raw capability and nothing
 * above it. This is the one place the server chooses between them, so nothing
 * downstream knows which runtime it is talking to — the observation log, the
 * phase reducer, accounting, and the WS stream are identical either way, which
 * is exactly what makes the scripted adapter a legitimate test double rather
 * than a second code path.
 */
export interface RuntimeLaunch {
  readonly config: RuntimeStartConfig;
  /**
   * Adapter-specific launch data. Only the scripted adapter reads it (its
   * declared script); every other adapter ignores it, and a script handed to
   * one is refused rather than silently dropped.
   */
  readonly script?: RuntimeScript;
}

export class RuntimeRegistry {
  readonly #adapters = new Map<string, SessionRuntimeAdapter>();
  #defaultId: string | null = null;

  register(
    adapter: SessionRuntimeAdapter,
    options: { default?: boolean } = {},
  ) {
    this.#adapters.set(adapter.id, adapter);
    if (options.default === true || this.#defaultId === null) {
      this.#defaultId = adapter.id;
    }
  }

  ids(): readonly string[] {
    return [...this.#adapters.keys()];
  }

  get defaultId(): string {
    if (this.#defaultId === null) {
      throw new Error("no session runtime adapter is registered");
    }
    return this.#defaultId;
  }

  /**
   * An unknown adapter is a refusal with the reason attached, never a fallback:
   * running work on a runtime the operator did not ask for is worse than not
   * running it.
   */
  require(adapterId?: string | null): SessionRuntimeAdapter {
    const id = adapterId ?? this.defaultId;
    const adapter = this.#adapters.get(id);
    if (!adapter) {
      throw refused({
        reason: "unknown_runtime",
        message: `no session runtime named "${id}" is available (have: ${this.ids().join(", ")})`,
      });
    }
    return adapter;
  }

  /**
   * Start a native session. The permission-enforcement check runs here rather
   * than at each call site: a runtime that cannot refuse a tool call on the
   * host's word may not run work at all, because approvals (§6.6) and claims
   * (§3.4) would be advice instead of gates (decision 0001, C6).
   */
  async start(
    adapterId: string | null | undefined,
    launch: RuntimeLaunch,
  ): Promise<{
    readonly adapter: SessionRuntimeAdapter;
    readonly handle: RuntimeSessionHandle;
  }> {
    const adapter = this.require(adapterId);

    const enforcement = checkPermissionEnforcement(adapter.capabilities);
    if (!enforcement.allowed) {
      throw refused(enforcement.refusal);
    }

    if (launch.script !== undefined) {
      if (!isScriptedRuntime(adapter)) {
        throw refused({
          reason: "script_not_supported",
          message: `runtime "${adapter.id}" does not replay a declared script`,
        });
      }
      return {
        adapter,
        handle: await adapter.startWithScript(launch.script, launch.config),
      };
    }

    return { adapter, handle: await adapter.start(launch.config) };
  }
}
