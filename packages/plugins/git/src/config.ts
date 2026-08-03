/**
 * The git kind's configuration, validated by the kind itself (§3.4, §10.1).
 *
 * `WorkspaceKindConfig` is an opaque JSON record in the contract: the host does not
 * know what is in it and cannot check it, so `checkConfig` is where a malformed
 * configuration is refused **with a reason and the fields that were wrong** — never
 * thrown, because a plugin that throws is an unavailable plugin (§10.2).
 *
 * There is deliberately no field here that could carry a credential, and
 * `checkRemoteUrl` refuses one that smuggles it into a URL: an
 * `https://token@host/repo` remote would be readable by every session in the
 * workspace (§3.4).
 */
import type { WorkspaceKindConfig } from "@plotroom/plugin-sdk";

export const GIT_PROVISION_STRATEGIES = ["auto", "worktree", "clone"] as const;

export type GitProvisionStrategy = (typeof GIT_PROVISION_STRATEGIES)[number];

export interface GitWorkspaceConfig {
  /** Where the workspace will live. */
  readonly workspacePath: string;
  /** An existing checkout to branch from; `git worktree` shares its objects. */
  readonly repositoryPath: string | null;
  /** Cloned from when there is no local checkout to share. */
  readonly remoteUrl: string | null;
  readonly strategy: GitProvisionStrategy;
  /** Set once; an existing branch is never renamed or re-derived (§3.4). */
  readonly branch: string | null;
  readonly branchTemplate: string;
  readonly branchInputs: Readonly<Record<string, string | null>>;
  /** What a brand-new branch starts from, and what a diff is measured against. */
  readonly baseRef: string | null;
  readonly remoteName: string;
}

export interface GitConfigRefusal {
  readonly message: string;
  readonly fields: readonly string[];
}

export type GitConfigParse =
  | { readonly valid: true; readonly config: GitWorkspaceConfig }
  | { readonly valid: false; readonly refusal: GitConfigRefusal };

export const DEFAULT_BRANCH_TEMPLATE = "plotroom/{ticket|slug}";

function readString(
  raw: WorkspaceKindConfig,
  name: string,
  invalid: string[],
): string | null {
  const value = raw[name];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    invalid.push(name);
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function parseGitConfig(raw: WorkspaceKindConfig): GitConfigParse {
  const fields: string[] = [];

  const workspacePath = readString(raw, "workspacePath", fields);
  const repositoryPath = readString(raw, "repositoryPath", fields);
  const remoteUrl = readString(raw, "remoteUrl", fields);
  const branch = readString(raw, "branch", fields);
  const branchTemplate =
    readString(raw, "branchTemplate", fields) ?? DEFAULT_BRANCH_TEMPLATE;
  const baseRef = readString(raw, "baseRef", fields);
  const remoteName = readString(raw, "remoteName", fields) ?? "origin";

  const rawStrategy = readString(raw, "strategy", fields) ?? "auto";
  if (!(GIT_PROVISION_STRATEGIES as readonly string[]).includes(rawStrategy)) {
    fields.push("strategy");
  }
  const strategy = rawStrategy as GitProvisionStrategy;

  const branchInputs: Record<string, string | null> = {};
  const rawInputs = raw["branchInputs"];
  if (rawInputs !== undefined && rawInputs !== null) {
    if (typeof rawInputs !== "object" || Array.isArray(rawInputs)) {
      fields.push("branchInputs");
    } else {
      for (const [key, value] of Object.entries(
        rawInputs as Record<string, unknown>,
      )) {
        if (value !== null && typeof value !== "string") {
          fields.push("branchInputs");
          break;
        }
        branchInputs[key] = value as string | null;
      }
    }
  }

  if (workspacePath === null) {
    fields.push("workspacePath");
  }
  if (repositoryPath === null && remoteUrl === null) {
    fields.push("repositoryPath", "remoteUrl");
  }
  if (strategy === "worktree" && repositoryPath === null) {
    fields.push("repositoryPath");
  }
  if (strategy === "clone" && remoteUrl === null) {
    fields.push("remoteUrl");
  }

  if (fields.length > 0) {
    const unique = [...new Set(fields)];
    return {
      valid: false,
      refusal: {
        message: `Git workspace configuration is incomplete or malformed: ${unique.join(", ")}.`,
        fields: unique,
      },
    };
  }

  if (remoteUrl !== null) {
    const url = checkRemoteUrl(remoteUrl);
    if (!url.allowed) {
      return {
        valid: false,
        refusal: { message: url.message, fields: ["remoteUrl"] },
      };
    }
  }

  return {
    valid: true,
    config: {
      workspacePath: workspacePath as string,
      repositoryPath,
      remoteUrl,
      strategy,
      branch,
      branchTemplate,
      branchInputs,
      baseRef,
      remoteName,
    },
  };
}

const SCHEME_URL = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)@/u;
const SCP_LIKE = /^([^/@]+)@[^/:]+:/u;

export type RemoteUrlCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly message: string };

/**
 * A remote URL this plugin will work with. Anything carrying credentials is
 * refused — that remote would be readable by every session in the workspace, and
 * the credential would be one the host did not choose (§3.4). An SSH user name
 * survives: it is not a secret, and the key that answers for it is the host's.
 */
export function checkRemoteUrl(url: string): RemoteUrlCheck {
  const scheme = SCHEME_URL.exec(url);
  if (scheme !== null) {
    const protocol = (scheme[1] ?? "").toLowerCase();
    const userInfo = scheme[2] ?? "";
    if (protocol === "http" || protocol === "https") {
      return refuse(url, "credentials");
    }
    if (userInfo.includes(":")) {
      return refuse(url, "a password");
    }
    return { allowed: true };
  }
  const scp = SCP_LIKE.exec(url);
  if (scp !== null && (scp[1] ?? "").includes(":")) {
    return refuse(url, "a password");
  }
  return { allowed: true };
}

function refuse(url: string, what: string): RemoteUrlCheck {
  return {
    allowed: false,
    message:
      `Remote URL carries ${what} in it (${url.replace(/\/\/[^/]*@/u, "//***@")}). ` +
      `Workspace git uses the host's own authentication (§3.4).`,
  };
}

const SLUG_MAX = 48;

/** A branch-name-safe slug: lowercase, hyphenated, bounded. */
export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase()
    .slice(0, SLUG_MAX)
    .replace(/-+$/u, "");
}

/**
 * The branch a new workspace gets (§3.4): the configured name where there is one —
 * **an existing branch is never renamed or re-derived** — otherwise the template
 * with its inputs substituted. `{a|b}` takes the first input that has a value.
 *
 * A placeholder **nothing** answers abandons the template and falls back to the
 * workspace's own id: `plotroom/{ticket}` with no ticket would otherwise produce
 * `plotroom`, a branch named after nothing that every workspace would collide on.
 */
export function resolveBranchName(
  config: GitWorkspaceConfig,
  fallback: string,
): string {
  if (config.branch !== null) {
    return config.branch;
  }
  let unanswered = false;
  const substituted = config.branchTemplate.replace(
    /\{([^}]*)\}/gu,
    (_match, group: string) => {
      for (const name of group.split("|")) {
        const value = config.branchInputs[name.trim()];
        if (value !== undefined && value !== null && value.trim() !== "") {
          return slugify(value);
        }
      }
      unanswered = true;
      return "";
    },
  );
  if (unanswered) {
    return `plotroom/${slugify(fallback)}`;
  }
  const cleaned = substituted
    .split("/")
    .map((segment) => segment.replace(/-+/gu, "-").replace(/^-+|-+$/gu, ""))
    .filter((segment) => segment !== "")
    .join("/");
  return cleaned === "" ? `plotroom/${slugify(fallback)}` : cleaned;
}
