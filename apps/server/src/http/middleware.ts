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

/** Operator credential enforcement (spec §12), header or query param. */
export function credentialMiddleware(
  configuredCredential: string | null,
): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const result = checkCredential(
      {
        authorizationHeader: c.req.header("authorization"),
        credentialQueryParam: c.req.query("credential"),
      },
      configuredCredential,
    );
    if (!result.allowed) {
      throw unauthorized(result.reason);
    }
    await next();
  };
}

/** Structured request logging (spec §8): one line per request, level-aware. */
export function requestLogMiddleware(logger: Logger): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const start = Date.now();
    await next();
    logger.info("request", {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      durationMs: Date.now() - start,
    });
  };
}
