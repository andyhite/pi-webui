import type { OriginCheckPolicy } from "./origin.js";

/**
 * The two access-control settings that can change without a restart (§11,
 * §12, Epic 8.3): the trusted-origins allowlist and the operator credential.
 *
 * Both gates read this same object on every request (`checkOrigin`,
 * `checkCredential` in `http/middleware.ts`) — a plain mutable holder rather
 * than a getter trick or re-wiring every middleware, so a settings write is
 * one assignment and the very next request already sees it. Everything else
 * about the bind (loopback-only vs not, host, port) is genuinely fixed once
 * the socket opens (`security/bind-policy.ts`), which is why this holder
 * carries only the two settings that are not.
 */
export class LiveSecurityPolicy implements OriginCheckPolicy {
  trustedOrigins: readonly string[];
  credential: string | null;

  constructor(initial: {
    readonly trustedOrigins: readonly string[];
    readonly credential: string | null;
  }) {
    this.trustedOrigins = initial.trustedOrigins;
    this.credential = initial.credential;
  }
}
