/**
 * Injecting the operator credential into requests aimed at a remote
 * backend (spec §12), from the main process rather than the page.
 *
 * The renderer served by a remote backend is the exact same renderer
 * served locally (AGENTS.md: "one renderer, never forked per target") —
 * it has no idea it might be talking to a remote origin, and nothing in
 * `packages/ui`/`apps/web` appends a credential to its own `fetch`/`WebSocket`
 * calls. Rather than teach the renderer about credentials (a second
 * ownership boundary this batch does not cross), the main process's
 * `session.webRequest` rewrites every request bound for that origin before
 * it leaves the process — covering both plain HTTP (`/api/*`) and the `/ws`
 * upgrade handshake, since Chromium's network stack represents a WebSocket
 * handshake as an ordinary HTTP request at this layer.
 *
 * Matched by **hostname + port, plus security class** — deliberately not
 * full origin (protocol + host + port), and deliberately not host alone:
 *
 * - Not full origin: a plain `fetch()` to `/api/*` and the `/ws` upgrade
 *   both target the same backend, but the browser's own URL for each
 *   carries a different scheme (`https:`/`wss:` or `http:`/`ws:`) for the
 *   identical connection — comparing full origins made the `/ws` request's
 *   `ws://host:port` silently fail to match a remembered backend's
 *   `http://host:port` and never receive the header at all (caught by
 *   driving this against two real servers under Electron: every `/api/*`
 *   call carried the credential, every `/ws` upgrade got refused with 401
 *   until this matched across that pair).
 * - Not host alone: `URL#host` elides the *default* port for its own
 *   scheme (`https://host` and `http://host` both report `host`, no
 *   `:443`/`:80`), so a backend remembered as `https://host` matched a
 *   plain `http://host` request once ports were left implicit — the exact
 *   downgrade that would carry the Bearer credential over cleartext.
 *   Ports are resolved to their scheme's default before comparing, and a
 *   request must be in the **same security class** as the remembered
 *   backend (`http`/`ws` together, `https`/`wss` together) — the pairing
 *   the previous point depends on, kept, but never crossing secure and
 *   insecure.
 */

function isSecureProtocol(protocol: string): boolean {
  return protocol === "https:" || protocol === "wss:";
}

function defaultPortFor(protocol: string): string {
  return isSecureProtocol(protocol) ? "443" : "80";
}

/** `hostname:port`, with an implicit port resolved to its scheme's default. */
function normalizedHostPort(url: URL): string {
  return `${url.hostname}:${url.port || defaultPortFor(url.protocol)}`;
}

/** See the doc comment above for exactly what this does and does not match. */
export function originMatches(
  requestUrl: string,
  targetOrigin: string,
): boolean {
  try {
    const request = new URL(requestUrl);
    const target = new URL(targetOrigin);
    if (
      isSecureProtocol(request.protocol) !== isSecureProtocol(target.protocol)
    ) {
      return false;
    }
    return normalizedHostPort(request) === normalizedHostPort(target);
  } catch {
    return false;
  }
}

/**
 * Bearer header (Track A's `checkCredential` reads either this or a WS
 * query param; the header covers both transports here, so there is no need
 * to also rewrite the URL for the query-param path).
 */
export function buildInjectedHeaders(
  existingHeaders: Record<string, string>,
  credential: string,
): Record<string, string> {
  return { ...existingHeaders, Authorization: `Bearer ${credential}` };
}
