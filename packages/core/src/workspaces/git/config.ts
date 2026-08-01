import type { WorkspaceConfigCheck, WorkspaceKindConfig } from "../kind.js";
import {
  DEFAULT_BRANCH_TEMPLATE,
  type BranchTemplateInputs,
} from "./branch-template.js";
import { checkRemoteUrl } from "./host-auth.js";

/**
 * The git kind's configuration (§3.4, §10.1).
 *
 * A kind validates its own configuration, because a plugin-supplied kind
 * receives it as JSON across a worker boundary. There is deliberately no field
 * here that could carry a credential — the host-auth test asserts that, and
 * `checkRemoteUrl` refuses a URL that smuggles one in.
 */

export const GIT_PROVISION_STRATEGIES = ["auto", "worktree", "clone"] as const;

export type GitProvisionStrategy = (typeof GIT_PROVISION_STRATEGIES)[number];

export interface GitWorkspaceConfig {
  /** Where the workspace will live. */
  readonly workspacePath: string;
  /**
   * An existing checkout to branch from. Provisioning from it uses
   * `git worktree`, which shares its object store — the cheapest reuse git
   * offers (§3.4, cost awareness).
   */
  readonly repositoryPath: string | null;
  /** Cloned from when there is no local checkout to share. */
  readonly remoteUrl: string | null;
  readonly strategy: GitProvisionStrategy;
  /** Set once; an existing branch is never renamed or re-derived (§3.4). */
  readonly branch: string | null;
  readonly branchTemplate: string;
  readonly branchInputs: BranchTemplateInputs;
  /** What a brand-new branch starts from; defaults to the remote's HEAD. */
  readonly baseRef: string | null;
  readonly remoteName: string;
  /** A shared mirror cache, so the second workspace for a repository is cheap. */
  readonly cacheDir: string | null;
}

export interface ParsedGitConfig {
  readonly valid: true;
  readonly config: GitWorkspaceConfig;
}

export type GitConfigParse =
  ParsedGitConfig | (WorkspaceConfigCheck & { valid: false });

function stringField(
  raw: WorkspaceKindConfig,
  name: string,
): string | null | "invalid" {
  const value = raw[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "invalid";
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function parseGitConfig(raw: WorkspaceKindConfig): GitConfigParse {
  const fields: string[] = [];
  const readString = (name: string): string | null => {
    const value = stringField(raw, name);
    if (value === "invalid") {
      fields.push(name);
      return null;
    }
    return value;
  };

  const workspacePath = readString("workspacePath");
  const repositoryPath = readString("repositoryPath");
  const remoteUrl = readString("remoteUrl");
  const branch = readString("branch");
  const branchTemplate =
    readString("branchTemplate") ?? DEFAULT_BRANCH_TEMPLATE;
  const baseRef = readString("baseRef");
  const remoteName = readString("remoteName") ?? "origin";
  const cacheDir = readString("cacheDir");

  const rawStrategy = readString("strategy") ?? "auto";
  if (!(GIT_PROVISION_STRATEGIES as readonly string[]).includes(rawStrategy)) {
    fields.push("strategy");
  }
  const strategy = rawStrategy as GitProvisionStrategy;

  const rawInputs = raw["branchInputs"];
  let branchInputs: BranchTemplateInputs = {};
  if (rawInputs !== undefined && rawInputs !== null) {
    if (typeof rawInputs !== "object" || Array.isArray(rawInputs)) {
      fields.push("branchInputs");
    } else {
      const entries = Object.entries(rawInputs as Record<string, unknown>);
      const bad = entries.filter(
        ([, value]) => value !== null && typeof value !== "string",
      );
      if (bad.length > 0) {
        fields.push("branchInputs");
      } else {
        branchInputs = Object.fromEntries(entries) as BranchTemplateInputs;
      }
    }
  }

  if (workspacePath === null) fields.push("workspacePath");
  if (repositoryPath === null && remoteUrl === null) {
    fields.push("repositoryPath", "remoteUrl");
  }
  if (strategy === "worktree" && repositoryPath === null) {
    fields.push("repositoryPath");
  }
  if (strategy === "clone" && remoteUrl === null) fields.push("remoteUrl");

  if (fields.length > 0) {
    return {
      valid: false,
      refusal: {
        reason: "invalid_config",
        message: `Git workspace configuration is incomplete or malformed: ${[...new Set(fields)].join(", ")}.`,
        fields: [...new Set(fields)],
      },
    };
  }

  if (remoteUrl !== null) {
    const urlCheck = checkRemoteUrl(remoteUrl);
    if (!urlCheck.allowed) {
      return {
        valid: false,
        refusal: {
          reason: "invalid_config",
          message: urlCheck.refusal.message,
          fields: ["remoteUrl"],
        },
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
      cacheDir,
    },
  };
}

/** A stable directory name for a remote's mirror in the shared cache. */
export function mirrorCacheKey(remoteUrl: string): string {
  const normalized = remoteUrl
    .replace(/\.git$/u, "")
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();
  return `${normalized}.git`;
}
