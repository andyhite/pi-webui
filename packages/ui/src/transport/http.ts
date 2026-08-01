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
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

export interface HttpClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
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
  ): Promise<T> {
    assertSameOriginPath(path);

    const response = await fetchImpl(path, {
      method,
      headers:
        requestBody === undefined ? {} : { "content-type": "application/json" },
      ...(requestBody === undefined
        ? {}
        : { body: JSON.stringify(requestBody) }),
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
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    put: (path, body) => request("PUT", path, body),
    patch: (path, body) => request("PATCH", path, body),
    delete: (path) => request("DELETE", path),
  };
}
