import type { Approval } from "@plotroom/core";
import { ApiError } from "../http/errors.js";

/**
 * What a refused plugin call is, as an answer rather than a crash.
 *
 * These live in their own module because two subsystems need to recognise them and
 * neither should have to import the other's machinery: `plugins/invoker.ts` throws
 * them, and `integrations/service.ts` catches them to keep one distinction §9.3 and
 * §10.2 make and a single `catch` would erase —
 *
 * **an ungranted permission is not a broken connection.** A refresh that failed
 * because GitHub rejected the token marks the integration broken, because that is a
 * connection health problem the operator fixes by reconnecting. A refresh the host
 * refused because nobody has answered a permission request is a *plugin* state, and
 * marking the integration broken for it would send the operator to re-enter a
 * credential that was never the problem.
 */

/**
 * A permission nobody has answered (§10.2, §6.6).
 *
 * Two shapes, one class, because they are one fact seen from two places: with a
 * calling session there is an approval to answer and the call is **blocked** (202,
 * exactly like the write-action path's must-ask); with no session there is nobody to
 * ask, so the reach is refused (403) naming the operator's own grant route.
 */
export class PluginPermissionAskedError extends ApiError {
  readonly pluginId: string;
  readonly permissionId: string;
  /** Non-null when the ask was raised against a session; null when there was none. */
  readonly approval: Approval | null;

  constructor(input: {
    readonly pluginId: string;
    readonly permissionId: string;
    readonly reason: string;
    readonly approval: Approval | null;
  }) {
    super(
      input.approval === null ? 403 : 202,
      input.approval === null
        ? "plugin_permission_ungranted"
        : "plugin_permission_asked",
      input.reason,
      input.approval === null
        ? { pluginId: input.pluginId, permissionId: input.permissionId }
        : {
            pluginId: input.pluginId,
            permissionId: input.permissionId,
            approvalId: input.approval.id,
          },
    );
    this.name = "PluginPermissionAskedError";
    this.pluginId = input.pluginId;
    this.permissionId = input.permissionId;
    this.approval = input.approval;
  }
}

/**
 * A refusal no grant can answer: an unknown contribution, a granted credential
 * nothing has stored, a tool call with no calling session, or a permission the
 * operator **already denied** — that one was answered, and re-raising it would be
 * asking again with nobody having changed anything.
 */
export class PluginCallRefusalError extends ApiError {
  readonly pluginId: string;

  constructor(pluginId: string, reason: string) {
    super(409, "plugin_call_refused", reason, { pluginId });
    this.name = "PluginCallRefusalError";
    this.pluginId = pluginId;
  }
}

/** True for either: a refusal the host made before the plugin ran the call. */
export function isPluginRefusal(error: unknown): boolean {
  return (
    error instanceof PluginPermissionAskedError ||
    error instanceof PluginCallRefusalError
  );
}
