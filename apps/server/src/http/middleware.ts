import type { Context, MiddlewareHandler, Next } from "hono";
import { checkCredential } from "../security/credential.js";
import { checkOrigin, type OriginCheckPolicy } from "../security/origin.js";
import type { Logger } from "../logging/logger.js";
import { forbidden, unauthorized } from "./errors.js";

/**
 * Origin/Host validation as HTTP middleware (spec §12) — the same
 * {@link checkOrigin} predicate the WS upgrade route uses, so the two
 * transports cannot silently diverge on what counts as "local".
 */
export function originCheckMiddleware(
  policy: OriginCheckPolicy,
): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const result = checkOrigin(
      {
        origin: c.req.header("origin"),
        host: c.req.header("host"),
      },
      policy,
    );
    if (!result.allowed) {
      throw forbidden(result.reason);
    }
    await next();
  };
}

export interface CredentialPolicy {
  readonly credential: string | null;
}

/**
 * Operator credential enforcement (spec §12), header or query param.
 *
 * Takes the policy object rather than the credential string itself, and
 * reads `.credential` fresh on every request: a settings write (§11,
 * Epic 8.3) that changes it is live from the very next request, with no
 * restart, because there is no primitive value captured in this closure to
 * go stale.
 */
export function credentialMiddleware(
  policy: CredentialPolicy,
): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const result = checkCredential(
      {
        authorizationHeader: c.req.header("authorization"),
        credentialQueryParam: c.req.query("credential"),
      },
      policy.credential,
    );
    if (!result.allowed) {
      throw unauthorized(result.reason);
    }
    await next();
  };
}

/** Structured request logging (spec §8): one line per request, level-aware. */
export function requestLogMiddleware(logger: Logger): MiddlewareHandler {
  // Tagged so the Logs panel can filter to just HTTP traffic (Epic 8.3).
  const http = logger.child("http");
  return async (c: Context, next: Next) => {
    const start = Date.now();
    await next();
    http.info("request", {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      durationMs: Date.now() - start,
    });
  };
}
