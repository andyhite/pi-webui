/**
 * Running git from inside a plugin worker (§3.4, §9.4).
 *
 * The contract gives a plugin two injected capabilities — a log line and its
 * per-call credentials (`HOST_INJECTED_CAPABILITIES`) — and **no way to run a
 * command**. So this plugin brings its own command seam: `GitExec` is a dependency
 * the plugin's entry point supplies (`node:child_process` in the shipped entry, a
 * recorded fake or a real spawner in tests), which keeps the git mechanics testable
 * without the host learning a fifteenth invocation kind.
 *
 * Everything else here is the **host-auth invariant** (§3.4), ported rather than
 * relaxed: "App-held credentials are never used for workspace git operations and
 * never written into a workspace's git configuration or remotes." Two mechanisms
 * make that true in a plugin, where it matters more than natively because a plugin
 * is the thing that holds an integration token:
 *
 * 1. **The environment is an allowlist, not a scrub.** `hostGitEnv` builds the
 *    child's environment from a fixed list of host-configuration variables, so a
 *    token cannot reach git by being set anywhere.
 * 2. **`runGit` takes no environment argument.** A caller cannot pass one, which is
 *    why the invariant is checkable rather than remembered — and why this plugin
 *    requests no credential permission at all: it has nothing to inject a token
 *    into.
 */

export interface ShellCommand {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The complete environment for the child; a replacement, never a patch. */
  readonly env: Readonly<Record<string, string>>;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The host-supplied command seam. The plugin describes; this runs. */
export type GitExec = (command: ShellCommand) => Promise<CommandResult>;

export interface GitContext {
  readonly exec: GitExec;
  /** The host's environment, filtered by allowlist before git sees any of it. */
  readonly hostEnvironment: Readonly<Record<string, string | undefined>>;
  /** The git binary; a host may keep it somewhere other than `PATH`. */
  readonly gitProgram?: string;
}

/**
 * Everything a workspace git command may see. Each of these describes *the host* —
 * where its git and SSH configuration live, which agent socket to talk to. None can
 * carry an app credential, because the app sets none of them.
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
 * Set on every workspace git command. `GIT_TERMINAL_PROMPT=0` is not a credential:
 * it is the difference between failing honestly with git's own reason and hanging on
 * a prompt no operator is watching.
 */
export const WORKSPACE_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
};

export function hostGitEnv(
  hostEnvironment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const name of HOST_GIT_ENV_ALLOWLIST) {
    const value = hostEnvironment[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return { ...env, ...WORKSPACE_GIT_ENV };
}

export interface GitOutcome extends CommandResult {
  readonly args: readonly string[];
  readonly cwd: string;
}

export async function runGit(
  context: GitContext,
  invocation: { readonly cwd: string; readonly args: readonly string[] },
): Promise<GitOutcome> {
  const result = await context.exec({
    program: context.gitProgram ?? "git",
    args: invocation.args,
    cwd: invocation.cwd,
    env: hostGitEnv(context.hostEnvironment),
  });
  return { ...result, args: invocation.args, cwd: invocation.cwd };
}

/** One line for a provisioning log, with nothing secret in it. */
export function describeInvocation(outcome: GitOutcome): string {
  return `git ${outcome.args.map(redact).join(" ")} (in ${outcome.cwd}) → exit ${outcome.exitCode}`;
}

export function gitFailureMessage(outcome: GitOutcome): string {
  const stderr = outcome.stderr.trim();
  const stdout = outcome.stdout.trim();
  const detail = stderr !== "" ? stderr : stdout;
  return `git ${outcome.args.map(redact).join(" ")} failed (exit ${outcome.exitCode})${
    detail === "" ? "" : `: ${detail}`
  }`;
}

const AUTH_FAILURE_PATTERNS: readonly RegExp[] = [
  /permission denied \(publickey/iu,
  /authentication failed/iu,
  /could not read (?:username|password)/iu,
  /terminal prompts disabled/iu,
  /host key verification failed/iu,
  /access denied/iu,
  /repository not found/iu,
];

/**
 * Whether git failed because **the host** could not authenticate. Reported as its
 * own provisioning failure so the operator sees "your machine cannot reach this
 * repository", and never answered by reaching for a credential of the app's (§3.4).
 */
export function isHostAuthFailure(outcome: GitOutcome): boolean {
  if (outcome.exitCode === 0) {
    return false;
  }
  return AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(outcome.stderr));
}

/** Never echo a secret into a message that lands in a log (§8). */
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
 * What a provisioned workspace's own (`--local`) git configuration is checked for.
 * The host's global configuration is deliberately not inspected: the host's
 * credential helper is the host's business, and using it is the point.
 */
export function findCredentialMaterial(
  localGitConfig: string,
): readonly { readonly line: string; readonly detail: string }[] {
  const findings: { line: string; detail: string }[] = [];
  for (const rawLine of localGitConfig.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    for (const { pattern, detail } of CREDENTIAL_PATTERNS) {
      if (pattern.test(line)) {
        findings.push({ line: redact(line), detail });
        break;
      }
    }
  }
  return findings;
}
