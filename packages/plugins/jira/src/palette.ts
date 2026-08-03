/**
 * Jira's palette entry (§10.1, §11), in a leaf module of its own so the
 * renderer half of this plugin (`renderer-manifest.ts`) can carry it without
 * importing the transport-bound host manifest.
 */
import type { PaletteEntry } from "@plotroom/plugin-sdk";

import { JIRA_SCOPE_EXAMPLE } from "./scope.js";

export const SEARCH_PALETTE_ENTRY_ID = "jira-search-by-jql";

export const jiraSearchPaletteEntry: PaletteEntry = {
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
};
