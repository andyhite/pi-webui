import { isLoopbackHostname } from "./origin.js";

/**
 * Bind policy (spec §12): bound to the local machine by default; remote
 * access is expected to be tunnelled. Binding a non-loopback address is an
 * explicit two-part opt-in — the flag *and* a configured credential — so a
 * `host` typo (or a config copied from a remote-access guide without reading
 * it) cannot silently expose the server with no access control.
 */
export interface BindPolicyInput {
  readonly host: string;
  readonly allowNonLoopbackBind: boolean;
  readonly credential: string | null;
}

export type BindPolicyResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function checkBindPolicy(input: BindPolicyInput): BindPolicyResult {
  if (isLoopbackHostname(input.host)) {
    return { ok: true };
  }

  if (!input.allowNonLoopbackBind) {
    return {
      ok: false,
      reason:
        `refusing to bind non-loopback host "${input.host}" without ` +
        "PLOTROOM_ALLOW_NON_LOOPBACK_BIND=1 (spec §12)",
    };
  }

  if (input.credential === null || input.credential.length === 0) {
    return {
      ok: false,
      reason:
        `refusing to bind non-loopback host "${input.host}" without an ` +
        "operator credential (PLOTROOM_CREDENTIAL) — required for non-local " +
        "binding (spec §12)",
    };
  }

  return { ok: true };
}
