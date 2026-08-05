import type {
  EpochMillis,
  RequestOutcome,
  RuntimeRequest,
  RuntimeRequestId,
  SessionHostEvent,
} from "@plotroom/core";

/**
 * The gate's channel back to PlotRoom (§3.4's C6, §6.4, §6.6).
 *
 * The decision — approvals, claims, pre-grants — lives in the server process;
 * this process only embeds the SDK. So a gate extension cannot call the
 * decision path directly, the way `apps/server/src/sessions/gate.ts` can: it
 * raises a `request-raised` observation over the frame channel, the same one
 * every other observation travels, and blocks the SDK's own call until a
 * matching `respond` command answers it on stdin (issue #81).
 *
 * This is the in-process half of the shape the pi adapter already has over its
 * RPC wire (`ctx.ui.confirm` → `extension_ui_request` → blocked → answered);
 * the difference is only which side fabricates `request-settled` — pi's
 * adapter does, because pi's own RPC has no acknowledgement for a UI response.
 * Here the sidecar is what emits both observations, because nothing else will.
 */
export interface RequestBridge {
  /**
   * Raise a request and resolve when PlotRoom answers. Never rejects: a
   * runtime request has no failure mode PlotRoom does not answer as an
   * outcome (a denial is an outcome, not an error).
   */
  raise(request: RuntimeRequest): Promise<RequestOutcome>;
  /**
   * Settle a previously raised request — what the `respond` command calls.
   * Returns false for an id nothing is waiting on (already settled, or never
   * raised), so the command loop can nack truthfully instead of pretending.
   */
  settle(requestId: RuntimeRequestId, outcome: RequestOutcome): boolean;
}

export function createRequestBridge(
  writeFrame: (frame: SessionHostEvent) => void,
  now: () => EpochMillis,
): RequestBridge {
  let sequence = 0;
  const pending = new Map<
    RuntimeRequestId,
    (outcome: RequestOutcome) => void
  >();

  return {
    raise(request) {
      sequence += 1;
      const requestId = `sidecar-${sequence.toString()}`;

      const settled = new Promise<RequestOutcome>((resolve) => {
        pending.set(requestId, resolve);
      });

      writeFrame({
        type: "observation",
        observation: { kind: "request-raised", requestId, request, at: now() },
      });

      return settled;
    },

    settle(requestId, outcome) {
      const resolve = pending.get(requestId);
      if (resolve === undefined) return false;

      pending.delete(requestId);
      resolve(outcome);

      // The sidecar's own fact, not an acknowledgement from the SDK: nothing
      // else observes that the answer reached the blocked call, and a request
      // left open forever is a session `deriveSessionPhase` reads as still
      // waiting on an approval that was in fact already settled (§6.6).
      writeFrame({
        type: "observation",
        observation: { kind: "request-settled", requestId, outcome, at: now() },
      });
      return true;
    },
  };
}
