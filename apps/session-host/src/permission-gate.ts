import type {
  ToolCallEvent,
  ToolCallEventResult,
} from "@oh-my-pi/pi-coding-agent";
import type { RequestBridge } from "./request-bridge.js";

/**
 * C6 for the embedded SDK (decision 0001, issue #81): "approvals (§6.6) and
 * path claims (§3.4) gate the runtime rather than advise it."
 *
 * The SDK's own primitive is the `tool_call` extension hook: it runs before
 * every tool the model calls — read-tier tools included, unlike a gate that
 * only wraps writes — and a `{block: true, reason}` result stops the call with
 * no side effect, the model reading `reason` as the tool's own error. That is
 * the shape `apps/server/src/runtime/omp.spike.test.ts`'s "denies a gated tool
 * call" case proves against the real SDK: a denied call produced no side
 * effect and the model got an error; without this extension the same call
 * ran.
 *
 * The decision itself is `apps/server/src/sessions/gate.ts`'s, in the server
 * process this sidecar is not; `bridge.raise` is what reaches it (§3.4/§6.6
 * over the frame channel, `request-bridge.ts`).
 *
 * **A ceiling this hook has and `plotroom_ask` (`ask-tool.ts`) does not**,
 * verified live against omp 17.2.8: the SDK bounds a `tool_call` *extension*
 * handler to 30 seconds and fails closed on its own timeout — `{block: true,
 * reason: "Extension … timed out after 30000ms"}` — with no documented way to
 * raise it. `bridge.raise` still resolves whenever PlotRoom eventually
 * answers, but a call the SDK already timed out is unaffected by that answer
 * arriving late: the model already saw the SDK's own denial. Fail-closed, so
 * no side effect either way (§6.6's floor holds) — but an approval genuinely
 * answered after 30 seconds reads as the SDK's generic timeout rather than
 * the operator's own reason. `plotroom_ask`'s tool `execute()` has no such
 * ceiling; only this hook does. Tracked as a follow-up rather than solved
 * here — the SDK exposes no configuration for it.
 */
export const BOOT_ASSERTION_TOOL_NAME = "plotroom-boot-assertion";

/**
 * The handler `pi.on("tool_call", …)` registers — exported so the boot
 * assertion (`main.ts`) can call the *exact* function the SDK will call,
 * without a round trip through the SDK's own dispatch.
 */
export type ToolCallHandler = (
  event: ToolCallEvent,
) => Promise<ToolCallEventResult>;

/**
 * Builds the handler and hands it back alongside the extension factory the
 * SDK loads it through — the boot assertion needs the handler directly, and
 * `createAgentSession({ extensions })` needs the factory.
 */
export function createPermissionGateHandler(
  bridge: RequestBridge,
): ToolCallHandler {
  return async (event) => {
    // The boot assertion's own probe (issue #81's "non-negotiable" half): a
    // reserved name real tools never use, denied without touching the wire —
    // proving this exact function is wired to `bridge`, before anything else
    // may run through it.
    if (event.toolName === BOOT_ASSERTION_TOOL_NAME) {
      return { block: true, reason: "boot assertion" };
    }

    const outcome = await bridge.raise({
      kind: "tool-permission",
      toolName: event.toolName,
      input: event.input,
    });

    switch (outcome.kind) {
      case "allow":
        return {};
      case "deny":
        return { block: true, reason: outcome.reason };
      case "answer":
        // A tool-permission request is never answered with an answer — the
        // gate and §6.4's questions are different requests (`decideToolPermission`
        // refuses the reverse case for the same reason). Fail closed rather
        // than assume what an unexpected outcome shape meant.
        return {
          block: true,
          reason: "PlotRoom answered with the wrong shape",
        };
    }
  };
}
