/**
 * The HTTP seam (§9.3, §10.2).
 *
 * The contract injects a log line and per-call credentials and nothing else — there
 * is no HTTP client in a plugin's reach — so this plugin brings its own, **as an
 * injected dependency rather than a global**. That is what makes the whole plugin
 * testable without the network: the shipped entry point supplies a `fetch`-backed
 * transport, and the tests supply a recorded one, so no test in this repository can
 * reach Jira.
 *
 * **A credential is never read from the environment here.** The connection arrives in
 * `context.credentials` for one call, from the host, for a granted credential
 * permission only (§9.3) — and the host redacts any injected value out of whatever
 * this plugin returns. Nothing in this package reads `process.env` at all.
 *
 * ## The Jira connection, and the one place it is spelled out
 *
 * Jira Cloud authenticates an API call with HTTP Basic over `email:apiToken`
 * (`Authorization: Basic base64(email:token)`), so the credential the operator stores
 * through the connect flow is that **pair**, one string, colon-separated. A value with
 * no colon in it is not a Jira Cloud credential, and the connect is refused saying so
 * — a connection problem, never mysteriously missing data (§9.3).
 *
 * ## Why the site is not a credential
 *
 * The other half of a Jira connection is the **site** (`acme.atlassian.net`), which is
 * not a secret and must not be injected as one: the host redacts every injected value
 * out of a result, so a site delivered through the credential channel would redact
 * itself out of every issue link this plugin returns. There is no other per-connection
 * configuration channel in contract v1 — `PluginCallContext` carries credentials and a
 * log function, and that is the whole list — so the site reaches this plugin the way
 * the git port's checkout path did: **in the producer's scope, and as a declared input
 * on every write, tool and condition check**. Recorded as a contract finding rather
 * than worked around by abusing the credential channel.
 */

export interface HttpRequest {
  readonly method: "GET" | "POST" | "PUT";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
}

export type HttpTransport = (request: HttpRequest) => Promise<HttpResponse>;

/** The credential permission's id and system, as the host knows them (§9.3). */
export const JIRA_CREDENTIAL_ID = "jira-basic-auth";
export const JIRA_CREDENTIAL_SYSTEM = "jira";

/**
 * The declared network scope. Jira Cloud sites are per-installation subdomains, so
 * the declaration names the family rather than one host — narrower than `*`, and the
 * operator reads exactly this sentence on the grant surface.
 */
export const JIRA_NETWORK_HOSTS = ["*.atlassian.net"] as const;

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      /** Null when the failure was not an answer at all (an unreachable host). */
      readonly status: number | null;
      /** Jira's own text, unedited (§9.2) — including a rejection's reason. */
      readonly message: string;
    };

/**
 * A Jira connection for exactly one call and one site.
 *
 * Both the credential and the site are constructor arguments rather than fields this
 * module can go and find: a `JiraApi` without them **cannot be built**, which is how
 * "a broken or expired connection is an integration health problem, never mysteriously
 * missing data" (§9.3) becomes a shape rather than a habit.
 */
export class JiraApi {
  readonly #transport: HttpTransport;
  readonly #site: string;
  readonly #authorization: string;

  private constructor(
    transport: HttpTransport,
    site: string,
    authorization: string,
  ) {
    this.#transport = transport;
    this.#site = site;
    this.#authorization = authorization;
  }

  get site(): string {
    return this.#site;
  }

  /**
   * Build a client, or say why there is none. Called at the top of every handler:
   * the credential is per call, so the connection is too.
   */
  static connect(
    transport: HttpTransport,
    site: string,
    credentials: Readonly<Record<string, string>>,
  ):
    | { readonly connected: true; readonly api: JiraApi }
    | { readonly connected: false; readonly why: string } {
    const pair = credentials[JIRA_CREDENTIAL_ID];
    if (pair === undefined || pair === "") {
      return {
        connected: false,
        why:
          `the Jira connection is not usable: no ${JIRA_CREDENTIAL_ID} was injected for this call. ` +
          `Grant the credential permission and store the connection; this is a connection problem, not missing data (§9.3)`,
      };
    }
    const separator = pair.indexOf(":");
    if (separator <= 0 || separator === pair.length - 1) {
      return {
        connected: false,
        why:
          `the stored ${JIRA_CREDENTIAL_ID} is not a Jira Cloud credential: it must be the account email and API token as "email:token". ` +
          `This is a connection problem, not missing data (§9.3)`,
      };
    }
    return {
      connected: true,
      api: new JiraApi(
        transport,
        site,
        `Basic ${Buffer.from(pair, "utf8").toString("base64")}`,
      ),
    };
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

  async #send(
    method: HttpRequest["method"],
    path: string,
    body: unknown,
  ): Promise<ApiResult<unknown>> {
    let response: HttpResponse;
    try {
      response = await this.#transport({
        method,
        url: `https://${this.#site}${path}`,
        headers: {
          accept: "application/json",
          authorization: this.#authorization,
          "user-agent": "plotroom-jira-plugin",
          ...(body === null ? {} : { "content-type": "application/json" }),
        },
        body: body === null ? null : JSON.stringify(body),
      });
    } catch (error) {
      // A transport that threw is a connection problem, reported as one.
      return {
        ok: false,
        status: null,
        message: `Jira could not be reached at ${this.#site}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    const parsed = parseJson(response.body);
    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        status: response.status,
        // Jira's own error text, verbatim (§9.2).
        message: `Jira answered ${response.status}: ${
          messageOf(parsed) ?? response.body.trim() ?? "no body"
        }`,
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

/**
 * Jira reports failures three ways — `errorMessages`, a field-keyed `errors` map, and
 * a bare `message` — and all three are the source's own words, so all three are passed
 * through rather than flattened into one of PlotRoom's (§9.2).
 */
function messageOf(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const raw = parsed as Record<string, unknown>;
  const parts: string[] = [];
  if (Array.isArray(raw["errorMessages"])) {
    parts.push(
      ...raw["errorMessages"].filter(
        (entry): entry is string => typeof entry === "string",
      ),
    );
  }
  const errors = raw["errors"];
  if (typeof errors === "object" && errors !== null && !Array.isArray(errors)) {
    for (const [field, text] of Object.entries(
      errors as Record<string, unknown>,
    )) {
      parts.push(`${field}: ${String(text)}`);
    }
  }
  if (typeof raw["message"] === "string") {
    parts.push(raw["message"]);
  }
  return parts.length === 0 ? null : parts.join("; ");
}
