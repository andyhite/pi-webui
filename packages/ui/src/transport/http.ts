/**
 * The fetch half of the client transport layer (spec §12's single-origin
 * rule): every call takes a same-origin path like `/api/graph`, never a full
 * URL — so a hardcoded host or port cannot creep in anywhere a caller uses
 * this client. In dev, the Vite dev server proxies `/api` to the local
 * server (see `apps/web/vite.config.ts`); in production, the server serves
 * both the page and the API on the one origin. Either way this file never
 * knows or cares which.
 */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`request to ${path} failed with status ${status}`);
    this.name = "HttpError";
  }
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
    body?: unknown,
  ): Promise<T> {
    assertSameOriginPath(path);

    const response = await fetchImpl(path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (!response.ok) {
      throw new HttpError(response.status, path);
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
    delete: (path) => request("DELETE", path),
  };
}
