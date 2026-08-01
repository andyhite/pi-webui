/**
 * Origin/Host validation (Epic 2.1, spec §12).
 *
 * The threat: a page loaded from anywhere on the internet runs script that
 * targets `http://localhost:<port>` (drive-by) or a DNS name that resolves to
 * 127.0.0.1 (rebinding), hoping the browser's same-origin policy doesn't
 * apply because the target "looks local". The browser still sends the
 * requesting page's real `Origin`, so checking it — never the `Host` header,
 * which a rebinding attack controls by definition — is what blocks this.
 *
 * The requirement this must not break: `ssh -L <port>:127.0.0.1:<port>` plus
 * a browser tab at `http://localhost:<port>` works with zero configuration,
 * because that browser tab's Origin *is* a trusted loopback origin.
 */

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** IPv4 loopback is the whole 127.0.0.0/8 range, not just 127.0.0.1. */
function isIPv4Loopback(hostname: string): boolean {
  const match = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return false;
  return match
    .slice(1)
    .every((octet) => Number(octet) >= 0 && Number(octet) <= 255);
}

/** Strips `[...]` from an IPv6 host-in-URL form (`[::1]`) down to `::1`. */
function unbracket(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

/**
 * Loopback names are always trusted, with any port (spec §12) — the port is
 * deliberately not part of this check.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const bare = unbracket(hostname).toLowerCase();
  return LOOPBACK_HOSTNAMES.has(bare) || isIPv4Loopback(bare);
}

function hostnameOf(originOrHost: string): string | null {
  try {
    // A bare Host header value ("localhost:4600") is not a valid URL; give it
    // a scheme so URL can parse the hostname out of either form.
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(originOrHost)
      ? originOrHost
      : `http://${originOrHost}`;
    return new URL(withScheme).hostname;
  } catch {
    return null;
  }
}

export interface OriginCheckRequest {
  readonly origin: string | undefined;
  readonly host: string | undefined;
}

export interface OriginCheckPolicy {
  /** Exact origins allow-listed beyond loopback (e.g. a reverse proxy). */
  readonly trustedOrigins: readonly string[];
}

export type OriginCheckResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/**
 * Validates a request's `Origin` (preferred) or `Host` (fallback, for
 * non-browser clients that never send `Origin`) against the loopback rule
 * plus the explicit allow-list. Refuses by default — an unparseable or
 * entirely missing header is not "trusted by omission".
 */
export function checkOrigin(
  request: OriginCheckRequest,
  policy: OriginCheckPolicy,
): OriginCheckResult {
  if (request.origin !== undefined) {
    const hostname = hostnameOf(request.origin);
    if (hostname === null) {
      return {
        allowed: false,
        reason: `unparseable origin: ${request.origin}`,
      };
    }
    if (isLoopbackHostname(hostname)) return { allowed: true };
    if (policy.trustedOrigins.includes(request.origin))
      return { allowed: true };
    return {
      allowed: false,
      reason: `origin not trusted: ${request.origin}`,
    };
  }

  if (request.host !== undefined) {
    const hostname = hostnameOf(request.host);
    if (hostname !== null && isLoopbackHostname(hostname)) {
      return { allowed: true };
    }
    const trustedHostnames = policy.trustedOrigins
      .map(hostnameOf)
      .filter((name): name is string => name !== null);
    if (hostname !== null && trustedHostnames.includes(hostname)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `no Origin header and Host not loopback: ${request.host}`,
    };
  }

  return { allowed: false, reason: "no Origin or Host header present" };
}
