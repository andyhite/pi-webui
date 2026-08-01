import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Operator credential check (spec §12): a single shared secret, not a user
 * system. Optional while bound to loopback; {@link checkBindPolicy} refuses
 * to start at all if it is missing while bound non-loopback, so by the time
 * a request reaches this check, "credential configured" already implies
 * "required".
 *
 * Browsers cannot set custom headers on a WebSocket handshake, so the
 * credential travels two ways: `Authorization: Bearer <credential>` for
 * ordinary HTTP calls and non-browser WS clients, or a `credential` query
 * parameter for the browser's native WebSocket constructor. Both are read
 * the same way here so the two transports enforce identically.
 */
export interface CredentialCheckRequest {
  readonly authorizationHeader: string | undefined;
  readonly credentialQueryParam: string | undefined;
}

export type CredentialCheckResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

function bearerToken(
  authorizationHeader: string | undefined,
): string | undefined {
  if (!authorizationHeader) return undefined;
  const match = /^Bearer (.+)$/.exec(authorizationHeader);
  return match?.[1];
}

/**
 * Constant-time comparison, over digests rather than the strings themselves.
 *
 * `timingSafeEqual` needs equal-length buffers, and comparing the raw strings
 * would mean returning early on a length mismatch — which leaks the
 * credential's length to anyone willing to time the refusals. Hashing first
 * makes both sides a fixed 32 bytes, so every wrong credential costs the same
 * regardless of what was presented.
 */
function safeEqual(a: string, b: string): boolean {
  const digest = (value: string): Buffer =>
    createHash("sha256").update(value, "utf8").digest();

  return timingSafeEqual(digest(a), digest(b));
}

/** `null` configured credential means no credential is required at all. */
export function checkCredential(
  request: CredentialCheckRequest,
  configuredCredential: string | null,
): CredentialCheckResult {
  if (configuredCredential === null) return { allowed: true };

  const presented =
    bearerToken(request.authorizationHeader) ?? request.credentialQueryParam;

  if (presented === undefined) {
    return { allowed: false, reason: "missing operator credential" };
  }
  if (!safeEqual(presented, configuredCredential)) {
    return { allowed: false, reason: "invalid operator credential" };
  }
  return { allowed: true };
}
