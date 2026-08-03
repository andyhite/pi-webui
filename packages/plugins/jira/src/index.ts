/**
 * `@plotroom/plugin-jira` — the Jira in-box plugin (§9.4).
 *
 * The default export is the manifest the host loads. This module is the only one in the
 * package that touches the network: it supplies a `fetch`-backed transport, so every
 * other module is a description of Jira that a recorded transport can drive — which is
 * why no test in this repository can reach Jira.
 */
import type { PluginManifest } from "@plotroom/plugin-sdk";

import { createJiraPlugin } from "./plugin.js";
import type { HttpTransport } from "./transport.js";

/**
 * The shipped transport. It carries only what the caller built: no ambient headers, no
 * credential of its own, and no retry that would turn one write into two.
 */
export function fetchTransport(): HttpTransport {
  return async (request) => {
    const response = await fetch(request.url, {
      method: request.method,
      headers: { ...request.headers },
      ...(request.body === null ? {} : { body: request.body }),
    });
    return { status: response.status, body: await response.text() };
  };
}

const manifest: PluginManifest = createJiraPlugin({
  transport: fetchTransport(),
});

export default manifest;

export {
  createJiraPlugin,
  CREDENTIAL_PERMISSION,
  JIRA_PLUGIN_ID,
  NETWORK_PERMISSION,
  SEARCH_PALETTE_ENTRY_ID,
} from "./plugin.js";
export type { JiraPluginDeps } from "./plugin.js";
export {
  JIRA_CREDENTIAL_ID,
  JIRA_CREDENTIAL_SYSTEM,
  JIRA_NETWORK_HOSTS,
} from "./transport.js";
export type { HttpRequest, HttpResponse, HttpTransport } from "./transport.js";
export {
  collectionExternalId,
  parseCollectionMembers,
  ticketExternalId,
  workflowExternalId,
} from "./model.js";
export {
  JIRA_SCOPE_EXAMPLE,
  JIRA_SCOPE_LANGUAGE,
  parseExternalId,
  parseJiraScope,
} from "./scope.js";
export {
  EPIC_PRODUCER_ID,
  ISSUE_PRODUCER_ID,
  WORKFLOW_PRODUCER_ID,
} from "./producers.js";
export {
  ASSIGN_ACTION,
  COMMENT_ACTION,
  CREATE_ISSUE_ACTION,
  TRANSITION_ACTION,
  UPDATE_SUMMARY_ACTION,
} from "./writes.js";
export {
  EPIC_CHILDREN_RESOLVED_CHECK,
  ISSUE_IN_STATUS_CHECK,
} from "./conditions.js";
export {
  CARD_RENDERER_ID,
  CONTENT_RENDERER_ID,
  EXPAND_CARD_ACTION_ID,
  TRANSITION_CARD_ACTION_ID,
} from "./renderers.js";
