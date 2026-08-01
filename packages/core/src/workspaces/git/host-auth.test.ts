import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { CommandExec, ShellCommand } from "../exec.js";
import { newWorkspaceId } from "../ids.js";
import { GIT_WORKSPACE_KIND } from "../kind.js";
import { parseGitConfig } from "./config.js";
import {
  HOST_GIT_ENV_ALLOWLIST,
  WORKSPACE_GIT_ENV,
  checkRemoteUrl,
  findCredentialMaterial,
  hostGitEnv,
  redact,
} from "./host-auth.js";
import { provisionGitWorkspace } from "./provision.js";

/**
 * The host-auth invariant (§3.4, §9.3), proved rather than asserted.
 *
 * "Git operations inside a workspace use the machine's own git and SSH
 * configuration. App-held credentials are never used for workspace git
 * operations and never written into a workspace's git configuration or
 * remotes... A clone the host cannot authenticate fails honestly, with the
 * reason, rather than falling back to an app credential."
 *
 * Four claims, each with a test that fails if the code stops making it true:
 *
 * 1. The git layer has no credential input anywhere in its API.
 * 2. Nothing reaches git except an allowlist of host configuration — an
 *    injected token in the process environment does not reach a workspace
 *    command even when it is sitting right there.
 * 3. A remote URL carrying a credential is refused, and what the product
 *    provisions is checked afterwards for one.
 * 4. Failing to authenticate ends provisioning with git's own reason and no
 *    second attempt.
 */

const NOW = 1_700_000_000_000;

const GIT_LAYER_DIR = fileURLToPath(new URL(".", import.meta.url));
const WORKSPACES_DIR = fileURLToPath(new URL("..", import.meta.url));

const CREDENTIAL_VOCABULARY =
  /(?:token|password|passphrase|secret|credential|apikey|api_key|authorization|bearer)/iu;

function sourceFiles(
  directory: string,
): readonly { name: string; source: string }[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts"),
    )
    .map((entry) => ({
      name: entry.name,
      source: readFileSync(`${directory}/${entry.name}`, "utf8"),
    }));
}

/** Property and field names declared in a file — the shape of its API. */
function declaredFieldNames(source: string): readonly string[] {
  const names: string[] = [];
  for (const line of source.split("\n")) {
    const match = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/u.exec(line);
    if (match !== null) names.push(match[1] as string);
  }
  return names;
}

describe("the git layer has no credential input (§3.4)", () => {
  it("declares no field that could carry one, outside the module that refuses them", () => {
    const offenders = sourceFiles(GIT_LAYER_DIR)
      .filter((file) => file.name !== "host-auth.ts")
      .flatMap((file) =>
        declaredFieldNames(file.source)
          .filter((name) => CREDENTIAL_VOCABULARY.test(name))
          .map((name) => `${file.name}: ${name}`),
      );

    expect(offenders).toEqual([]);
  });

  it("declares no such field in the kind-agnostic workspace model either", () => {
    const offenders = sourceFiles(WORKSPACES_DIR).flatMap((file) =>
      declaredFieldNames(file.source)
        .filter((name) => CREDENTIAL_VOCABULARY.test(name))
        .map((name) => `${file.name}: ${name}`),
    );

    expect(offenders).toEqual([]);
  });

  it("gives no caller a way to pass an environment to git", () => {
    const exec = readFileSync(`${GIT_LAYER_DIR}/exec.ts`, "utf8");
    const invocation = /export interface GitInvocation \{([^}]*)\}/u.exec(exec);

    expect(invocation).not.toBeNull();
    expect(invocation?.[1]).not.toContain("env");
  });

  it("builds every command's environment through hostGitEnv", () => {
    const callSites: string[] = [];
    for (const file of sourceFiles(GIT_LAYER_DIR)) {
      const pattern = /exec\(\{/gu;
      let match: RegExpExecArray | null = pattern.exec(file.source);
      while (match !== null) {
        const block = file.source.slice(match.index, match.index + 400);
        callSites.push(
          `${file.name}:${block.includes("hostGitEnv(") ? "ok" : "raw"}`,
        );
        match = pattern.exec(file.source);
      }
    }

    expect(callSites.length).toBeGreaterThan(0);
    expect(callSites.filter((site) => site.endsWith(":raw"))).toEqual([]);
  });
});

describe("hostGitEnv", () => {
  it("passes the host's own git and SSH configuration through", () => {
    const env = hostGitEnv({
      PATH: "/usr/bin",
      HOME: "/home/dev",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      XDG_CONFIG_HOME: "/home/dev/.config",
    });

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/home/dev",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      XDG_CONFIG_HOME: "/home/dev/.config",
    });
  });

  it("drops everything not on the allowlist, including injected credentials", () => {
    const env = hostGitEnv({
      PATH: "/usr/bin",
      GITHUB_TOKEN: "ghp_secret",
      GH_TOKEN: "ghp_secret",
      GIT_ASKPASS: "/opt/plotroom/askpass",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "!echo password=ghp_secret",
      PLOTROOM_INTEGRATION_TOKEN: "ghp_secret",
    });

    expect(Object.keys(env).sort()).toEqual(["GIT_TERMINAL_PROMPT", "PATH"]);
    expect(Object.values(env)).not.toContain("ghp_secret");
  });

  it("refuses to let a prompt stand in for authentication", () => {
    expect(hostGitEnv({ GIT_TERMINAL_PROMPT: "1" }).GIT_TERMINAL_PROMPT).toBe(
      "0",
    );
    expect(WORKSPACE_GIT_ENV.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("keeps the allowlist free of anything that could carry a credential", () => {
    expect(
      HOST_GIT_ENV_ALLOWLIST.filter((name) => CREDENTIAL_VOCABULARY.test(name)),
    ).toEqual([]);
  });
});

describe("workspace git runs on the host's environment and nothing else", () => {
  const HOST_ENVIRONMENT = {
    PATH: "/usr/bin",
    HOME: "/home/dev",
    SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
    GITHUB_TOKEN: "ghp_appcredential",
    GIT_ASKPASS: "/opt/plotroom/askpass",
    PLOTROOM_TOKEN: "ghp_appcredential",
  };

  async function provisionRecording(
    config: Record<string, unknown>,
  ): Promise<readonly ShellCommand[]> {
    const commands: ShellCommand[] = [];
    const exec: CommandExec = (command) => {
      commands.push(command);
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };

    await provisionGitWorkspace(
      {
        git: { exec, hostEnvironment: HOST_ENVIRONMENT },
        clock: () => NOW,
        scratchDirectory: "/state",
      },
      {
        workspaceId: newWorkspaceId(),
        kind: GIT_WORKSPACE_KIND,
        config,
        requestedAt: NOW,
      },
    );

    return commands;
  }

  it.each([
    [
      "worktree",
      {
        workspacePath: "/work/app-feat-thing",
        repositoryPath: "/repos/app",
        branch: "feat/thing",
      },
    ],
    [
      "clone",
      {
        workspacePath: "/work/app-feat-thing",
        remoteUrl: "https://github.com/acme/app.git",
        cacheDir: "/state/cache",
        branch: "feat/thing",
      },
    ],
  ])(
    "passes no app credential to any command while provisioning by %s",
    async (_strategy, config) => {
      const commands = await provisionRecording(config);

      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands) {
        const names = Object.keys(command.env);
        expect(
          names.filter(
            (name) =>
              !HOST_GIT_ENV_ALLOWLIST.includes(name) &&
              !(name in WORKSPACE_GIT_ENV),
          ),
        ).toEqual([]);
        expect(Object.values(command.env)).not.toContain("ghp_appcredential");
        expect(command.env.SSH_AUTH_SOCK).toBe("/tmp/ssh-agent.sock");
        expect(JSON.stringify(command.args)).not.toContain("ghp_appcredential");
      }
    },
  );
});

describe("credentials never enter a remote URL", () => {
  it.each([
    "https://x-access-token:ghp_secret@github.com/acme/app.git",
    "https://oauth2:ghp_secret@gitlab.com/acme/app.git",
    "https://someone@github.com/acme/app.git",
    "ssh://git:hunter2@host/acme/app.git",
  ])("refuses %s", (url) => {
    expect(checkRemoteUrl(url)).toMatchObject({
      allowed: false,
      refusal: { reason: "credential_in_url" },
    });
  });

  it.each([
    "git@github.com:acme/app.git",
    "ssh://git@github.com/acme/app.git",
    "https://github.com/acme/app.git",
    "/repos/app",
  ])("allows %s — the host's own key answers for it", (url) => {
    expect(checkRemoteUrl(url)).toEqual({ allowed: true });
  });

  it("refuses such a URL in configuration, without echoing the secret (§8)", () => {
    const parsed = parseGitConfig({
      workspacePath: "/work/app",
      remoteUrl: "https://x-access-token:ghp_secret@github.com/acme/app.git",
    });

    expect(parsed.valid).toBe(false);
    if (parsed.valid) return;
    expect(parsed.refusal.message).not.toContain("ghp_secret");
    expect(parsed.refusal.fields).toEqual(["remoteUrl"]);
  });

  it("redacts credentials out of anything it repeats back", () => {
    expect(
      redact("https://x-access-token:ghp_secret@github.com/acme/app.git"),
    ).toBe("https://***@github.com/acme/app.git");
  });
});

describe("the provisioned workspace is checked for credentials afterwards", () => {
  it("finds an embedded credential in a workspace's own git config", () => {
    const findings = findCredentialMaterial(
      [
        "core.bare=false",
        "remote.origin.url=https://x-access-token:ghp_secret@github.com/acme/app.git",
        "credential.helper=!plotroom-credential-helper",
      ].join("\n"),
    );

    expect(findings).toHaveLength(2);
    expect(JSON.stringify(findings)).not.toContain("ghp_secret");
  });

  it("finds nothing in a workspace provisioned over the host's own auth", () => {
    expect(
      findCredentialMaterial(
        [
          "core.repositoryformatversion=0",
          "remote.origin.url=git@github.com:acme/app.git",
          "branch.feat/thing.remote=origin",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("fails provisioning when the workspace ends up carrying one", async () => {
    const exec: CommandExec = (command) => {
      if (command.args[0] === "config" && command.args.includes("--list")) {
        return Promise.resolve({
          exitCode: 0,
          stdout:
            "remote.origin.url=https://x-access-token:ghp_secret@github.com/acme/app.git\n",
          stderr: "",
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };

    const outcome = await provisionGitWorkspace(
      {
        git: { exec, hostEnvironment: { PATH: "/usr/bin" } },
        clock: () => NOW,
        scratchDirectory: "/state",
      },
      {
        workspaceId: newWorkspaceId(),
        kind: GIT_WORKSPACE_KIND,
        config: {
          workspacePath: "/work/app",
          repositoryPath: "/repos/app",
          branch: "feat/thing",
        },
        requestedAt: NOW,
      },
    );

    expect(outcome.provisioned).toBe(false);
    if (outcome.provisioned) return;
    expect(outcome.failure.message).toContain("host's own authentication");
    expect(outcome.failure.message).not.toContain("ghp_secret");
  });
});

describe("a clone the host cannot authenticate fails honestly (§3.4)", () => {
  it("reports git's own reason and never tries again with anything else", async () => {
    const commands: ShellCommand[] = [];
    const exec: CommandExec = (command) => {
      commands.push(command);
      if (command.args[0] === "clone") {
        return Promise.resolve({
          exitCode: 128,
          stdout: "",
          stderr:
            "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    };

    const outcome = await provisionGitWorkspace(
      {
        git: {
          exec,
          hostEnvironment: {
            PATH: "/usr/bin",
            GITHUB_TOKEN: "ghp_appcredential",
          },
        },
        clock: () => NOW,
        scratchDirectory: "/state",
      },
      {
        workspaceId: newWorkspaceId(),
        kind: GIT_WORKSPACE_KIND,
        config: {
          workspacePath: "/work/app",
          remoteUrl: "git@github.com:acme/private.git",
          branch: "feat/thing",
        },
        requestedAt: NOW,
      },
    );

    expect(outcome.provisioned).toBe(false);
    if (outcome.provisioned) return;
    expect(outcome.failure.reason).toBe("host_auth");
    expect(outcome.failure.message).toContain("Permission denied (publickey)");
    expect(outcome.failure.message).toContain(
      "host's own git and SSH configuration",
    );

    const clones = commands.filter((command) => command.args[0] === "clone");
    expect(clones).toHaveLength(1);
    expect(
      commands.every(
        (command) => !Object.values(command.env).includes("ghp_appcredential"),
      ),
    ).toBe(true);
  });
});
