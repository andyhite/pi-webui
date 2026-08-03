/**
 * The GitHub plugin's manifest (§9.4, §3.4, Epic 7.3).
 *
 * Pull requests, reviews, issues as tickets, repository metadata, writes with
 * per-action reversibility, the two condition checks the native registry deliberately
 * does not ship, and **clone-from-a-pull-request** as a card action and a palette
 * entry.
 *
 * ## Three declarations that are the whole trust story
 *
 * - **`github-api`** — network, scoped to `api.github.com` and nothing else. This is
 *   a declaration the operator reads, not a sandbox: v1 does not confine sockets,
 *   and `docs/plugin-contract.md` says so rather than implying otherwise.
 * - **`github-token`** — the *use* of a credential by id and system. The value is the
 *   host's; it arrives in `context.credentials` for one call, for granted names only,
 *   and the host redacts any injected value out of whatever this plugin returns
 *   (§9.3). **Nothing in this package reads `process.env`**, which is the difference
 *   between a credential the operator granted and reach they did not.
 * - **Neither is `requiredToLoad`.** The host decides degradation from that
 *   declaration; a plugin cannot make itself essential (§10.2).
 *
 * The transport is injected, so every test in this repository runs against a recorded
 * one and none of them can reach GitHub.
 */
import type { PluginManifest } from "@plotroom/plugin-sdk";

import {
  checksGreenCheck,
  CHECKS_GREEN_CHECK,
  pullRequestExistsCheck,
  PULL_REQUEST_EXISTS_CHECK,
} from "./conditions.js";
import { githubClonePaletteEntry } from "./palette.js";
import {
  createPullRequestProducer,
  createRepositoryProducer,
  createReviewProducer,
  createTicketProducer,
} from "./producers.js";
import { GITHUB_PLUGIN_IDENTITY } from "./renderer-manifest.js";
import {
  createGitHubCardRenderer,
  createGitHubContentRenderer,
} from "./renderers.js";
import { createGitHubTools } from "./tools.js";
import {
  GITHUB_CREDENTIAL_ID,
  GITHUB_CREDENTIAL_SYSTEM,
  type HttpTransport,
} from "./transport.js";
import { createGitHubWriteActions } from "./writes.js";

export const GITHUB_PLUGIN_ID = GITHUB_PLUGIN_IDENTITY.id;
export const NETWORK_PERMISSION = "github-api";
export const CREDENTIAL_PERMISSION = "github-token";
export { CLONE_PALETTE_ENTRY_ID } from "./palette.js";

export interface GitHubPluginDeps {
  readonly transport: HttpTransport;
}

export function createGitHubPlugin(deps: GitHubPluginDeps): PluginManifest {
  const transport = deps.transport;
  // Every contribution that talks to GitHub needs both: the reach and the identity.
  const api = [NETWORK_PERMISSION, CREDENTIAL_PERMISSION];
  const writeActions = createGitHubWriteActions(transport, api);

  return {
    // Identity is stated once, in `renderer-manifest.ts`: the renderer half of
    // this plugin is the same plugin, and two spellings of that would be two.
    ...GITHUB_PLUGIN_IDENTITY,
    permissions: [
      {
        id: NETWORK_PERMISSION,
        kind: "network",
        scope: { kind: "network", hosts: ["api.github.com"] },
        reason:
          "read pull requests, reviews, issues and repository metadata, and perform the writes you ask for",
        requiredToLoad: false,
      },
      {
        id: CREDENTIAL_PERMISSION,
        kind: "credential",
        scope: {
          kind: "credential",
          credentialId: GITHUB_CREDENTIAL_ID,
          system: GITHUB_CREDENTIAL_SYSTEM,
        },
        reason: "authenticate to GitHub as you",
        requiredToLoad: false,
      },
    ],
    contributions: {
      conceptProducers: [
        createPullRequestProducer(transport, api),
        createReviewProducer(transport, api),
        createTicketProducer(transport, api),
        createRepositoryProducer(transport, api),
      ],
      writeActions,
      agentTools: createGitHubTools(transport, writeActions, api),
      contentRenderers: [createGitHubContentRenderer()],
      cardRenderers: [createGitHubCardRenderer()],
      conditionChecks: [
        pullRequestExistsCheck(transport, api),
        checksGreenCheck(transport, api),
      ],
      paletteEntries: [githubClonePaletteEntry],
      commandDefinitions: [
        {
          id: "github-review-a-pull-request",
          name: "Review a pull request",
          instruction:
            "Read the pull request and its diff, then leave a review comment naming what must change and why. Do not merge.",
          lifecycle: "producing",
          expectedOutcome:
            "a review comment exists on the pull request, and its checks are green",
          conditionCheckIds: [PULL_REQUEST_EXISTS_CHECK, CHECKS_GREEN_CHECK],
        },
      ],
    },
  };
}
