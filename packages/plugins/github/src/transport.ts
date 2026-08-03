/**
 * The HTTP seam (§9.3, §10.2).
 *
 * The contract injects a log line and per-call credentials and nothing else — there
 * is no HTTP client in a plugin's reach — so this plugin brings its own, **as an
 * injected dependency rather than a global**. That is what makes the whole plugin
 * testable without the network: the shipped entry point supplies a `fetch`-backed
 * transport, and the tests supply a recorded one, so no test in this repository can
 * reach GitHub.
 *
 * **A credential is never read from the environment here.** The token arrives in
 * `context.credentials` for one call, from the host, for a granted credential
 * permission only (§9.3) — and the host redacts any injected value out of whatever
 * this plugin returns. A plugin that read `process.env.GITHUB_TOKEN` would be reach
 * the operator never granted, so nothing in this package reads `process.env` at all.
 */

export interface HttpRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

export const GITHUB_API_ORIGIN = "https://api.github.com";
export const GITHUB_CREDENTIAL_ID = "github-token";
export const GITHUB_CREDENTIAL_SYSTEM = "github";

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      /** Null when the failure was not an answer at all (an unreachable host). */
      readonly status: number | null;
      /** GitHub's own text, unedited (§9.2) — including a rejection's reason. */
      readonly message: string;
    };

/**
 * A GitHub connection for exactly one call.
 *
 * The token is a constructor argument, not a field this module can go and find: an
 * `ApiClient` without one **cannot be built**, which is how "a broken or expired
 * connection is an integration health problem, never mysteriously missing data"
 * (§9.3) becomes a shape rather than a habit — the caller has to handle the absence.
 */
export class GitHubApi {
  readonly #transport: HttpTransport;
  readonly #token: string;

  constructor(transport: HttpTransport, token: string) {
    this.#transport = transport;
    this.#token = token;
  }

  /**
   * Build a client, or say why there is none. Called at the top of every handler:
   * the credential is per call, so the connection is too.
   */
  static connect(
    transport: HttpTransport,
    credentials: Readonly<Record<string, string>>,
  ):
    | { readonly connected: true; readonly api: GitHubApi }
    | { readonly connected: false; readonly why: string } {
    const token = credentials[GITHUB_CREDENTIAL_ID];
    if (token === undefined || token === "") {
      return {
        connected: false,
        why:
          `the GitHub connection is not usable: no ${GITHUB_CREDENTIAL_ID} was injected for this call. ` +
          `Grant the credential permission and store the token; this is a connection problem, not missing data (§9.3)`,
      };
    }
    return { connected: true, api: new GitHubApi(transport, token) };
  }

  get(path: string): Promise<ApiResult<unknown>> {
    return this.#send("GET", path, null);
  }

  post(path: string, body: unknown): Promise<ApiResult<unknown>> {
    return this.#send("POST", path, body);
  }

  put(path: string, body: unknown): Promise<ApiResult<unknown>> {
    return this.#send("PUT", path, body);
  }

  patch(path: string, body: unknown): Promise<ApiResult<unknown>> {
    return this.#send("PATCH", path, body);
  }

  async #send(
    method: HttpRequest["method"],
    path: string,
    body: unknown,
  ): Promise<ApiResult<unknown>> {
    let response: HttpResponse;
    try {
      response = await this.#transport({
        method,
        url: `${GITHUB_API_ORIGIN}${path}`,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.#token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "plotroom-github-plugin",
          ...(body === null ? {} : { "content-type": "application/json" }),
        },
        body: body === null ? null : JSON.stringify(body),
      });
    } catch (error) {
      // A transport that threw is a connection problem, reported as one.
      return {
        ok: false,
        status: null,
        message: `GitHub could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const parsed = parseJson(response.body);
    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        status: response.status,
        // GitHub's own error text, verbatim (§9.2).
        message: `GitHub answered ${response.status}: ${messageOf(parsed) ?? response.body.trim() ?? "no body"}`,
      };
    }
    return { ok: true, value: parsed };
  }
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function messageOf(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const message = (parsed as Record<string, unknown>)["message"];
  const errors = (parsed as Record<string, unknown>)["errors"];
  if (typeof message !== "string") {
    return null;
  }
  return Array.isArray(errors) && errors.length > 0
    ? `${message} (${errors.map((one) => JSON.stringify(one)).join(", ")})`
    : message;
}
