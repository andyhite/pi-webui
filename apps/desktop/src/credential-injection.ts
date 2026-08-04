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
 * Matched by **host** (hostname + port), deliberately *not* full origin
 * (protocol + host + port): a plain `fetch()` to `/api/*` and the `/ws`
 * upgrade both target the same backend, but the browser's own URL for
 * each carries a different scheme (`https:`/`wss:` or `http:`/`ws:`) for
 * the identical connection — comparing full origins made the `/ws`
 * request's `ws://host:port` silently fail to match a remembered
 * backend's `http://host:port` and never receive the header at all
 * (caught by driving this against two real servers under Electron: every
 * `/api/*` call carried the credential, every `/ws` upgrade got refused
 * with 401 until this was made host-only). Query strings and paths never
 * matter either way, since `URL#host` already excludes them.
 */

/** Compares `hostname:port` only — see the doc comment above for why not full origin. */
export function originMatches(
  requestUrl: string,
  targetOrigin: string,
): boolean {
  try {
    return new URL(requestUrl).host === new URL(targetOrigin).host;
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
