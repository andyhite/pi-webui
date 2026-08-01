/**
 * Credential handling at the host boundary (§9.3, §10.2).
 *
 * "Credentials are stored by the app and exposed to **no session and no other
 * plugin**." Two mechanisms make that true here, and they are separate on purpose:
 *
 * 1. **Injection is per call and per grant.** The worker is started with nothing;
 *    the host resolves values only for credential permissions the invoked
 *    contribution declared *and* the operator granted, and puts them in that one
 *    call's context.
 * 2. **Egress is redacted.** Whatever the plugin returns is scanned for the values
 *    the host just injected, and any occurrence is replaced before the result
 *    leaves the host. A plugin that echoes its token into a tool result hands the
 *    calling session `[redacted:<id>]` — the leak is a plugin bug, and the host
 *    does not depend on plugins not having it.
 *
 * Redaction is a string scan rather than a schema walk because a result is a plugin
 * author's data: the token can be anywhere in it, including inside an error message
 * a remote system echoed back.
 */

/** Resolves a credential value the operator stored. Null when there is none. */
export type CredentialResolver = (input: {
  readonly credentialId: string;
  readonly system: string;
}) => string | null | Promise<string | null>;

export interface InjectedCredential {
  readonly credentialId: string;
  readonly value: string;
}

/**
 * Values shorter than this are not redacted.
 *
 * A one-character "credential" would redact every occurrence of that character in
 * every result, which turns a leak guard into corruption. Four is the shortest
 * string it is honest to call a secret; a credential shorter than that is not one,
 * and pretending otherwise would be the silent damage principle 12 rules out.
 */
export const MINIMUM_REDACTABLE_LENGTH = 4;

/** Replace every injected credential value found anywhere in `value`. */
export function redactCredentials<T>(
  value: T,
  injected: readonly InjectedCredential[],
): T {
  const secrets = injected.filter(
    (credential) => credential.value.length >= MINIMUM_REDACTABLE_LENGTH,
  );
  if (secrets.length === 0) {
    return value;
  }
  return walk(value, secrets) as T;
}

function walk(value: unknown, secrets: readonly InjectedCredential[]): unknown {
  if (typeof value === "string") {
    let redacted = value;
    for (const secret of secrets) {
      redacted = redacted
        .split(secret.value)
        .join(`[redacted:${secret.credentialId}]`);
    }
    return redacted;
  }
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => walk(entry, secrets));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = walk(entry, secrets);
    }
    return out;
  }
  return value;
}
