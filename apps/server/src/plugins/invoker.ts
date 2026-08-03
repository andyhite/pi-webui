import type { Approval, ApprovalAsk, PiercedPreGrant } from "@plotroom/core";
import {
  PluginCallRefusedError,
  PluginUnavailableError,
  type InvocationKind,
  type InvocationOf,
  type PermissionRaise,
  type PluginActor,
  type PluginHost,
  type PluginId,
  type ResultOf,
} from "@plotroom/plugin-sdk";
import type { ApiError } from "../http/errors.js";
import type { Logger } from "../logging/logger.js";
import {
  PluginCallRefusalError,
  PluginPermissionAskedError,
} from "./errors.js";
import { permissionRaiseAsk } from "./raise.js";

/**
 * Every invocation of a plugin, and the one place a refusal becomes a §6.6 ask.
 *
 * The host already decides everything about the call — is the contribution there,
 * is the permission granted, whose session does a tool act as, does the credential
 * exist (§9.3). What is left, and what this module is, is the **server half of the
 * permission raise**: `docs/plugin-contract.md` §8's "catch
 * `PluginCallRefusedError`; when `error.raise` is non-null, raise a §6.6 approval
 * from it against the calling session".
 *
 * Three consequences of the recorded decision, each visible in the code below:
 *
 * - **The call stays blocked.** A raise produces {@link PluginPermissionAskedError},
 *   which carries the approval and *no result* — nothing is degraded, nothing is
 *   run, and the caller's own convention decides how a blocked call reads (a
 *   session's write action already answers 202 with the approval; an operator's
 *   refresh answers the same refusal it would for any other unanswered ask).
 * - **A denial raises nothing.** `error.raise` is null for a permission the
 *   operator already answered, and this only reports the reason: re-raising it
 *   would be asking again with nobody having changed anything.
 * - **Unblocking is a re-issue, not a queued continuation.** "Grants take effect on
 *   the next call (`PluginHost.setGrants`); nothing is re-run"
 *   (`docs/plugin-contract.md` §4). Approving the ask persists the grant and pushes
 *   it into the host, so the retry — the runtime's own retry of its tool call, or
 *   the operator refreshing again — succeeds. Nothing here holds a promise across
 *   an operator's absence, because a promise waiting on a person is a call that
 *   cannot survive a restart being reported as though it could.
 *
 * There is no call with no session that raises for somebody else: a raise needs a
 * session to be asked *against* (§6.6 approvals belong to one), so a plugin call
 * made by a schedule or by the operator is refused with the ungranted permission
 * named, and the operator's own grant route is where that is answered.
 *
 * The two error classes it throws live in `errors.ts`, because
 * `integrations/service.ts` catches them to keep one distinction a single `catch`
 * would erase: **an ungranted permission is not a broken connection.**
 */

/** What the invoker needs from `ApprovalService` — the gate's own three verbs. */
export interface InvokerApprovals {
  forCall(sessionId: string, callId: string): Approval | undefined;
  raise(input: {
    readonly sessionId: string;
    readonly workstreamId?: string;
    readonly ask: ApprovalAsk;
    readonly callId?: string | null;
    readonly pierced?: PiercedPreGrant | null;
  }): Approval;
}

export interface PluginInvokerDeps {
  readonly logger: Logger;
  /** The enabled plugin's running host, or null when it is not enabled. */
  readonly host: (pluginId: string) => PluginHost | null;
  readonly approvals?: InvokerApprovals;
  /**
   * Called when an approval is raised for a permission, so the service can grant
   * it the moment the operator approves — the pair is not recoverable from the
   * approval record, which carries §6.6's ask and not the raise.
   */
  readonly onRaised?: (input: {
    readonly approval: Approval;
    readonly raise: PermissionRaise;
  }) => void;
}

export class PluginInvoker {
  constructor(private readonly deps: PluginInvokerDeps) {}

  /**
   * One invocation, with the raise routed. `actor` is the request's actor, never a
   * plugin's — the host refuses a tool call without one, which is the principle-1
   * backstop rather than the primary check.
   */
  async invoke<K extends InvocationKind>(
    pluginId: PluginId | string,
    invocation: InvocationOf<K>,
    options: {
      readonly actor?: PluginActor | null;
      /** The calling session, for the ask. Absent means nobody to ask against. */
      readonly sessionId?: string | null;
      readonly workstreamId?: string | null;
      /** The caller's own id for this call, so a retry finds the same approval. */
      readonly callId?: string | null;
    } = {},
  ): Promise<ResultOf<K>> {
    const host = this.deps.host(pluginId);
    if (host === null) {
      throw new PluginUnavailableError(`${pluginId} is not enabled`);
    }
    try {
      return await host.invoke(invocation, {
        ...(options.actor === undefined || options.actor === null
          ? {}
          : { actor: options.actor }),
      });
    } catch (error) {
      if (!(error instanceof PluginCallRefusedError)) throw error;
      throw this.onRefusal(String(pluginId), invocation, error, options);
    }
  }

  private onRefusal(
    pluginId: string,
    invocation: {
      readonly kind: InvocationKind;
      readonly contributionId: string;
    },
    error: PluginCallRefusedError,
    options: {
      readonly sessionId?: string | null;
      readonly workstreamId?: string | null;
      readonly callId?: string | null;
    },
  ): ApiError {
    const raise = error.raise;
    if (raise === null) {
      // Answered, or nothing a grant could fix. Say what happened.
      return new PluginCallRefusalError(pluginId, error.reason);
    }

    const sessionId = options.sessionId ?? null;
    const approvals = this.deps.approvals;
    if (sessionId === null || approvals === undefined) {
      this.deps.logger.info("plugin permission ungranted", {
        pluginId,
        permissionId: raise.permissionId,
        invocation: `${invocation.kind}:${invocation.contributionId}`,
      });
      return new PluginPermissionAskedError({
        pluginId,
        permissionId: raise.permissionId,
        reason: `${error.reason}; ${raise.summary} — granting it is the operator's act (POST /api/plugins/${pluginId}/grants)`,
        approval: null,
      });
    }

    // Matched by call id, exactly like the write gate: a retry of the same call
    // finds the ask already waiting rather than asking twice (principle 9).
    const callId = options.callId ?? `plugin:${pluginId}:${raise.permissionId}`;
    const existing = approvals.forCall(sessionId, callId);
    const approval =
      existing ??
      approvals.raise({
        sessionId,
        ...(options.workstreamId === undefined || options.workstreamId === null
          ? {}
          : { workstreamId: options.workstreamId }),
        ask: permissionRaiseAsk(raise),
        callId,
      });
    if (existing === undefined) {
      this.deps.onRaised?.({ approval, raise });
    }
    return new PluginPermissionAskedError({
      pluginId,
      permissionId: raise.permissionId,
      reason: error.reason,
      approval,
    });
  }
}
