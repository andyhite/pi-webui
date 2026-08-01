/**
 * The host-auth invariant (§3.4, §9.3).
 *
 * "Git operations inside a workspace — fetch, push, clone — use the machine's
 * own git and SSH configuration... **App-held credentials are never used for
 * workspace git operations and never written into a workspace's git
 * configuration or remotes** — an integration token embedded in a remote URL
 * would be readable by any session in that workspace. A clone the host cannot
 * authenticate fails honestly, with the reason, rather than falling back to an
 * app credential."
 *
 * Three mechanisms make that true rather than intended, and this file is the
 * only place in the git layer that is allowed to name credential material at
 * all — `host-auth.test.ts` asserts the rest of the layer never does, so a
 * credential cannot be plumbed in without deleting a test:
 *
 * 1. **The environment is an allowlist, not a scrub.** `hostGitEnv` builds the
 *    child environment from a fixed list of host-configuration variables. A
 *    variable the app invented — a token, an askpass helper, a substituted
 *    `GIT_CONFIG_*` — cannot reach git by being added anywhere, because nothing
 *    outside the list is passed through.
 * 2. **URLs with credentials in them are refused**, inbound (what the product
 *    is asked to clone) and outbound (what ends up in the workspace's config).
 * 3. **There is no interactive fallback.** `GIT_TERMINAL_PROMPT=0` makes an
 *    unauthenticated fetch fail with git's own reason instead of hanging on a
 *    prompt no operator is watching.
 */

/**
 * Everything a workspace command may see. These describe *the host*: where its
 * git and SSH configuration live, which agent socket to talk to, where its
 * temporary files go. None of them can carry an app credential, because the app
 * does not set any of them.
 */
export const HOST_GIT_ENV_ALLOWLIST: readonly string[] = [
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "HOME",
  "USER",
  "LOGNAME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "WINDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
];

/**
 * Set by the product on every workspace command. `GIT_TERMINAL_PROMPT=0` is not
 * a credential: it is the difference between failing honestly with git's reason
 * and hanging forever on a prompt (§3.4).
 */
export const WORKSPACE_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
};

/**
 * The complete environment for a workspace command. A full replacement, built
 * from the host's own environment by allowlist — never a patch over it.
 */
export function hostGitEnv(
  hostEnvironment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const name of HOST_GIT_ENV_ALLOWLIST) {
    const value = hostEnvironment[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...WORKSPACE_GIT_ENV };
}

export interface RemoteUrlRefusal {
  readonly reason: "credential_in_url";
  readonly message: string;
}

export type RemoteUrlCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly refusal: RemoteUrlRefusal };

const SCHEME_URL = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)@/u;
const SCP_LIKE = /^([^/@]+)@[^/:]+:/u;

/**
 * A remote URL the product will work with. Anything carrying credentials in the
 * URL is refused: an `https://x-access-token:…@host/repo` remote is exactly the
 * failure §3.4 names — readable by every session in the workspace, and a
 * credential the host did not choose.
 *
 * `git@github.com:acme/app.git` and `ssh://git@host/repo` stay legal: an SSH
 * user name is not a secret, and the key that answers for it is the host's.
 */
export function checkRemoteUrl(url: string): RemoteUrlCheck {
  const scheme = SCHEME_URL.exec(url);
  if (scheme !== null) {
    const protocol = (scheme[1] ?? "").toLowerCase();
    const userInfo = scheme[2] ?? "";
    if (protocol === "http" || protocol === "https") {
      return refuseUrl(
        `Remote URL carries credentials in it (${redact(url)}). Workspace git uses the host's own authentication (§3.4).`,
      );
    }
    if (userInfo.includes(":")) {
      return refuseUrl(
        `Remote URL carries a password in it (${redact(url)}). Workspace git uses the host's own authentication (§3.4).`,
      );
    }
    return { allowed: true };
  }

  const scp = SCP_LIKE.exec(url);
  if (scp !== null && (scp[1] ?? "").includes(":")) {
    return refuseUrl(
      `Remote URL carries a password in it (${redact(url)}). Workspace git uses the host's own authentication (§3.4).`,
    );
  }

  return { allowed: true };
}

function refuseUrl(message: string): RemoteUrlCheck {
  return { allowed: false, refusal: { reason: "credential_in_url", message } };
}

/**
 * Never echo the secret back in a message that will land in a log (§8). The
 * patterns are unanchored and global on purpose: what is redacted is usually a
 * config line or an argv entry with the URL somewhere inside it, not a bare URL.
 * An SSH user name survives — it is not a secret, and a log that cannot name
 * the host is not worth keeping.
 */
export function redact(value: string): string {
  return value
    .replace(
      /([A-Za-z][A-Za-z0-9+.-]*):\/\/[^/\s@]*@/gu,
      (_match, scheme: string) => `${scheme}://***@`,
    )
    .replace(
      /(^|[\s=])([^\s/@:]+):[^\s/@]*@/gu,
      (_match, lead: string, user: string) => `${lead}${user}:***@`,
    );
}

export interface CredentialFinding {
  readonly line: string;
  readonly detail: string;
}

const CREDENTIAL_PATTERNS: readonly { pattern: RegExp; detail: string }[] = [
  {
    pattern: /^\s*url\s*=\s*[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*@/u,
    detail: "a remote URL with credentials embedded in it",
  },
  {
    pattern: /(?:oauth|access[_-]?token|api[_-]?token|apikey|api[_-]?key)/iu,
    detail: "a token",
  },
  { pattern: /password\s*=/iu, detail: "a password" },
  {
    pattern: /^\s*(?:helper|askpass|credential\.helper)\s*=\s*\S/iu,
    detail: "a credential helper written into the workspace",
  },
  {
    pattern: /(?:^|\s)(?:GIT_ASKPASS|GH_TOKEN|GITHUB_TOKEN)\b/u,
    detail: "an app-injected credential variable",
  },
];

/**
 * What a workspace's own (`--local`) git configuration is checked for after
 * provisioning. The host's global and system configuration is deliberately not
 * inspected: the host's credential helper is the host's business, and using it
 * is the point. This looks only at what the product wrote.
 */
export function findCredentialMaterial(
  localGitConfig: string,
): readonly CredentialFinding[] {
  const findings: CredentialFinding[] = [];
  for (const rawLine of localGitConfig.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    for (const { pattern, detail } of CREDENTIAL_PATTERNS) {
      if (pattern.test(line)) {
        findings.push({ line: redact(line), detail });
        break;
      }
    }
  }
  return findings;
}
