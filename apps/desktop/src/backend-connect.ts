/**
 * Connecting to a remote backend (spec §12, Epic 3.0's carry-over):
 * probing a remembered backend's health with its credential before this
 * process ever loads its origin into a window, so a stale or wrong
 * credential surfaces as "could not connect" rather than a page that loads
 * and then fails every API call silently.
 *
 * Pure decision, injected fetch — same shape as `spawn-or-attach.ts`'s
 * `healthProbe`, extended with a credential header because a remote
 * backend enforces one (§12: "real authentication required for a
 * non-local backend") where the local spawned server usually does not.
 */

export type FetchLike = (
  url: string,
  init?: { readonly headers?: Record<string, string> },
) => Promise<{ readonly ok: boolean; readonly status: number }>;

export interface RemoteHealthCheckInput {
  readonly url: string;
  readonly credential: string | null;
}

export type RemoteHealthCheckResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * `url` is a backend's bare origin (`https://host:port`, no trailing
 * slash assumed) — this appends `/api/health`, the same real route
 * `apps/desktop`'s local `healthProbe` already uses, never a bare
 * `/health` guess.
 */
export async function checkRemoteBackendHealth(
  input: RemoteHealthCheckInput,
  fetchImpl: FetchLike,
): Promise<RemoteHealthCheckResult> {
  const headers: Record<string, string> = {};
  if (input.credential !== null && input.credential.length > 0) {
    headers.Authorization = `Bearer ${input.credential}`;
  }

  let response: { readonly ok: boolean; readonly status: number };
  try {
    response = await fetchImpl(`${trimTrailingSlash(input.url)}/api/health`, {
      headers,
    });
  } catch (error) {
    return {
      ok: false,
      reason: `could not reach ${input.url}: ${String(
        error instanceof Error ? error.message : error,
      )}`,
    };
  }

  if (response.status === 401) {
    return {
      ok: false,
      reason: `${input.url} refused the credential (401) — check the operator credential and try again`,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: `${input.url} answered with status ${response.status}`,
    };
  }
  return { ok: true };
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
