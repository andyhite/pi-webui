/**
 * The Jira plugin's manifest (§9.4, §3.1, Epic 7.3).
 *
 * Tickets, **epics with their children as collections**, statuses and transitions as
 * content, five writes with per-action reversibility, the two condition checks the
 * native registry deliberately does not ship, and JQL as the scoping language (§9.1).
 *
 * ## Three declarations that are the whole trust story
 *
 * - **`jira-api`** — network, scoped to `*.atlassian.net` and nothing else. A Jira Cloud
 *   site is a per-installation subdomain, so the declaration names the family; it is a
 *   declaration the operator reads, not a sandbox — v1 does not confine sockets, and
 *   `docs/plugin-contract.md` says so rather than implying otherwise.
 * - **`jira-credential`** — the *use* of a credential by id and system. The value is the
 *   host's; it arrives in `context.credentials` for one call, for granted names only,
 *   and the host redacts any injected value out of whatever this plugin returns (§9.3).
 *   **Nothing in this package reads `process.env`**, which is the difference between a
 *   credential the operator granted and reach they did not.
 * - **Neither is `requiredToLoad`.** The host decides degradation from that declaration;
 *   a plugin cannot make itself essential (§10.2).
 *
 * The transport is injected, so every test in this repository runs against a recorded
 * one and none of them can reach Jira.
 */
import type { PluginManifest } from "@plotroom/plugin-sdk";

import {
  epicChildrenResolvedCheck,
  EPIC_CHILDREN_RESOLVED_CHECK,
  issueInStatusCheck,
  ISSUE_IN_STATUS_CHECK,
} from "./conditions.js";
import {
  createEpicProducer,
  createIssueProducer,
  createWorkflowProducer,
} from "./producers.js";
import {
  createJiraCardRenderer,
  createJiraContentRenderer,
} from "./renderers.js";
import { JIRA_SCOPE_EXAMPLE } from "./scope.js";
import { createJiraTools } from "./tools.js";
import {
  JIRA_CREDENTIAL_ID,
  JIRA_CREDENTIAL_SYSTEM,
  JIRA_NETWORK_HOSTS,
  type HttpTransport,
} from "./transport.js";
import { createJiraWriteActions } from "./writes.js";

export const JIRA_PLUGIN_ID = "jira";
export const NETWORK_PERMISSION = "jira-api";
export const CREDENTIAL_PERMISSION = "jira-credential";
export const SEARCH_PALETTE_ENTRY_ID = "jira-search-by-jql";

export interface JiraPluginDeps {
  readonly transport: HttpTransport;
}

export function createJiraPlugin(deps: JiraPluginDeps): PluginManifest {
  const transport = deps.transport;
  // Every contribution that talks to Jira needs both: the reach and the identity.
  const api = [NETWORK_PERMISSION, CREDENTIAL_PERMISSION];
  const writeActions = createJiraWriteActions(transport, api);

  return {
    id: JIRA_PLUGIN_ID,
    name: "Jira",
    version: "1.0.0",
    contractVersion: 1,
    permissions: [
      {
        id: NETWORK_PERMISSION,
        kind: "network",
        scope: { kind: "network", hosts: [...JIRA_NETWORK_HOSTS] },
        reason:
          "read issues, epics and workflows from your Jira site, and perform the writes you ask for",
        requiredToLoad: false,
      },
      {
        id: CREDENTIAL_PERMISSION,
        kind: "credential",
        scope: {
          kind: "credential",
          credentialId: JIRA_CREDENTIAL_ID,
          system: JIRA_CREDENTIAL_SYSTEM,
        },
        reason: "authenticate to Jira as you",
        requiredToLoad: false,
      },
    ],
    contributions: {
      conceptProducers: [
        createIssueProducer(transport, api),
        createEpicProducer(transport, api),
        createWorkflowProducer(transport, api),
      ],
      writeActions,
      agentTools: createJiraTools(transport, writeActions, api),
      contentRenderers: [createJiraContentRenderer()],
      cardRenderers: [createJiraCardRenderer()],
      conditionChecks: [
        issueInStatusCheck(transport, api),
        epicChildrenResolvedCheck(transport, api),
      ],
      paletteEntries: [
        {
          id: SEARCH_PALETTE_ENTRY_ID,
          label: "Jira: search issues by JQL",
          description: `Read issues into the graph from a JQL query, e.g. "${JIRA_SCOPE_EXAMPLE}" (§9.1).`,
          // All a palette entry can do in contract v1: `invoke` answers nothing and
          // the call context holds no reach into the host, so the gesture itself is
          // the host reading with the `jira-issues` producer over the scope the
          // operator typed. Reported as a contract finding rather than worked around.
          invoke: (context) => {
            context.log(
              "jira-search-by-jql was invoked; the read itself is the host's, over the jira-issues producer and the scope the operator entered (§9.1)",
            );
          },
        },
      ],
      commandDefinitions: [
        {
          id: "jira-work-a-ticket",
          name: "Work a Jira ticket",
          instruction:
            "Read the ticket and its workflow, do the work it asks for, then comment with what you did and move it on with the transition the workflow offers. Do not create new issues.",
          lifecycle: "producing",
          expectedOutcome:
            "the ticket is in a status Jira categorises as done, with a comment naming what was done",
          conditionCheckIds: [ISSUE_IN_STATUS_CHECK],
        },
        {
          id: "jira-close-out-an-epic",
          name: "Close out a Jira epic",
          instruction:
            "Read the epic's children, finish or reassign whatever is still open, and report what is left. Do not close the epic yourself.",
          lifecycle: "producing",
          expectedOutcome: "every child of the epic is in a done status",
          conditionCheckIds: [EPIC_CHILDREN_RESOLVED_CHECK],
        },
      ],
    },
  };
}
