/**
 * The fetch half of the client transport layer (spec §12's single-origin
 * rule): every call takes a same-origin path like `/api/graph`, never a full
 * URL — so a hardcoded host or port cannot creep in anywhere a caller uses
 * this client. In dev, the Vite dev server proxies `/api` to the local
 * server (see `apps/web/vite.config.ts`); in production, the server serves
 * both the page and the API on the one origin. Either way this file never
 * knows or cares which.
 */

/**
 * The server's one consistent error shape (`apps/server/src/http/errors.ts`'s
 * `ApiErrorBody`) — parsed here so a caller can read `code`/`reason` off a
 * caught `HttpError` instead of re-parsing JSON out of a generic failure.
 * `reason` in particular is a refusal's machine-readable predicate reason
 * (`would_cycle`, `session_not_running`, ...) — the same string the canvas's
 * mid-drag refusal shows, so a 409 here is a refusal to *surface*, never a
 * success and never a crash (principle 8).
 */
export class HttpError extends Error {
  /** Set when the response was JSON shaped like `ApiErrorBody`; `null` otherwise. */
  readonly code: string | null;
  readonly reason: string | null;

  constructor(
    readonly status: number,
    readonly path: string,
    body: unknown,
  ) {
    const parsed = parseApiErrorBody(body);
    super(parsed?.message ?? `request to ${path} failed with status ${status}`);
    this.name = "HttpError";
    this.code = parsed?.code ?? null;
    this.reason = parsed?.reason ?? null;
  }

  /** A 409 is specifically a domain refusal (Epic 2.2), never a bare failure. */
  get isRefusal(): boolean {
    return this.status === 409;
  }
}

function parseApiErrorBody(body: unknown): {
  readonly code: string;
  readonly message: string;
  readonly reason: string | null;
} | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const { code, message, details } = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
  if (typeof code !== "string" || typeof message !== "string") return null;
  const reason =
    typeof details === "object" &&
    details !== null &&
    typeof (details as { reason?: unknown }).reason === "string"
      ? (details as { reason: string }).reason
      : null;
  return { code, message, reason };
}

export type FetchLike = (
  input: string,
  init?: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly keepalive?: boolean;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

/**
 * Opt-in, per-request (spec §5, §12's durable-placement seam is the first
 * caller): a normal `fetch` is aborted the instant the document that made
 * it is torn down — navigation, reload, tab close. `keepalive` is the
 * browser's own mechanism for letting a small request outlive that (the
 * same guarantee `navigator.sendBeacon` gave before `fetch` grew the
 * option; unlike `sendBeacon`, it works for any method, including `PATCH`,
 * and any request this client sends fits comfortably under its combined
 * body-size budget — in the tens of KB, browser-dependent). Every existing
 * caller that never passes this is unaffected: the flag is absent from the
 * `fetch` call entirely, not merely `false`.
 */
export interface RequestOptions {
  readonly keepalive?: boolean;
}

export interface HttpClient {
  get<T>(path: string, options?: RequestOptions): Promise<T>;
  post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  put<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  patch<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  delete<T>(path: string, options?: RequestOptions): Promise<T>;
}

const ABSOLUTE_URL = /^[a-z][a-z\d+.-]*:\/\//i;

/**
 * Callers pass a path (`/api/...`); this refuses anything that looks like a
 * full URL rather than silently "helping" by making a cross-origin request.
 */
function assertSameOriginPath(path: string): void {
  if (ABSOLUTE_URL.test(path) || path.startsWith("//")) {
    throw new Error(
      `same-origin client received an absolute URL (${path}); pass a same-origin path instead`,
    );
  }
}

export function createHttpClient(fetchImpl: FetchLike): HttpClient {
  async function request<T>(
    method: string,
    path: string,
    requestBody?: unknown,
    options?: RequestOptions,
  ): Promise<T> {
    assertSameOriginPath(path);

    const response = await fetchImpl(path, {
      method,
      headers:
        requestBody === undefined ? {} : { "content-type": "application/json" },
      ...(requestBody === undefined
        ? {}
        : { body: JSON.stringify(requestBody) }),
      ...(options?.keepalive ? { keepalive: true } : {}),
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => null);
      throw new HttpError(response.status, path, errorBody);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  return {
    get: (path, options) => request("GET", path, undefined, options),
    post: (path, body, options) => request("POST", path, body, options),
    put: (path, body, options) => request("PUT", path, body, options),
    patch: (path, body, options) => request("PATCH", path, body, options),
    delete: (path, options) => request("DELETE", path, undefined, options),
  };
}
