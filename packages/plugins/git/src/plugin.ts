/**
 * The Coding/git plugin's manifest (§9.4, Epic 7.3).
 *
 * Phase 4 implemented git workspaces natively, in `@plotroom/core` and the server;
 * this is the **port onto the public contract** — a deliberate double touch, because
 * the git kind is the most demanding contribution in §10.1 and a contract that cannot
 * express it is the wrong contract. Nothing here imports `@plotroom/core`: a plugin
 * compiles against the SDK alone, and a port that borrowed core's implementation
 * would prove only that the two packages can share code.
 *
 * ## The two permissions, and the one it does not ask for
 *
 * - **`workspace-files`** — filesystem read-write. Blanket, and asked for as blanket:
 *   the checkouts are wherever the operator configured them, and a plugin that
 *   enumerated roots it cannot know would be declaring a boundary it does not have.
 * - **`repository-remotes`** — network, blanket for the same reason: a repository's
 *   remote is the operator's, over the *host's* git and SSH configuration.
 * - **No credential.** Workspace git authentication is the host's (§3.4), so this
 *   plugin asks for no credential at all and has none to write into a workspace's
 *   config or remotes. `provision` reads the checkout's own config back and refuses
 *   if anything credential-shaped is in it.
 *
 * Neither is `requiredToLoad`: the host decides degradation from that declaration,
 * and a plugin cannot make itself essential (§10.2).
 */
import type { PluginManifest } from "@plotroom/plugin-sdk";

import {
  branchIsCheck,
  CLEAN_CHECK_ID,
  commitsSinceBaseCheck,
  COMMITS_CHECK_ID,
  workspaceCleanCheck,
} from "./conditions.js";
import type { GitContext } from "./exec.js";
import { createGitWorkspaceKind, type GitKindDeps } from "./kind.js";
import { createCommitProducer, createDiffProducer } from "./producers.js";
import {
  createGitCardRenderer,
  createGitContentRenderer,
} from "./renderers.js";
import { createGitTools } from "./tools.js";

export const GIT_PLUGIN_ID = "coding-git";
export const FILES_PERMISSION = "workspace-files";
export const REMOTES_PERMISSION = "repository-remotes";

export type GitPluginDeps = GitKindDeps & { readonly git: GitContext };

export function createGitPlugin(deps: GitPluginDeps): PluginManifest {
  const context = deps.git;
  const files = [FILES_PERMISSION];
  const provisioning = [FILES_PERMISSION, REMOTES_PERMISSION];

  return {
    id: GIT_PLUGIN_ID,
    name: "Coding / git",
    version: "1.0.0",
    contractVersion: 1,
    permissions: [
      {
        id: FILES_PERMISSION,
        kind: "filesystem",
        scope: { kind: "filesystem", roots: ["*"], access: "read-write" },
        reason:
          "read and provision git checkouts wherever the operator configured them",
        requiredToLoad: false,
      },
      {
        id: REMOTES_PERMISSION,
        kind: "network",
        scope: { kind: "network", hosts: ["*"] },
        reason:
          "fetch and clone from a repository's own remotes, using the host's git and SSH configuration — never an app credential (§3.4)",
        requiredToLoad: false,
      },
    ],
    contributions: {
      workspaceKinds: [createGitWorkspaceKind(deps, provisioning)],
      conceptProducers: [
        createDiffProducer(context, files),
        createCommitProducer(context, files),
      ],
      contentRenderers: [createGitContentRenderer()],
      cardRenderers: [createGitCardRenderer()],
      conditionChecks: [
        workspaceCleanCheck(context, files),
        commitsSinceBaseCheck(context, files),
        branchIsCheck(context, files),
      ],
      agentTools: createGitTools(context, files),
      // A contributed definition is a starting point the operator edits, not a
      // locked one (§3.5): the host copies it in and this plugin does not own it
      // afterwards.
      commandDefinitions: [
        {
          id: "git-record-the-work",
          name: "Record the work in git",
          instruction:
            "Review the workspace's changes, then commit them on the workspace's branch with a message that explains why the change was made. Do not push.",
          lifecycle: "producing",
          expectedOutcome:
            "the workspace has at least one new commit since its base ref and no uncommitted changes remain",
          conditionCheckIds: [COMMITS_CHECK_ID, CLEAN_CHECK_ID],
        },
      ],
    },
  };
}
