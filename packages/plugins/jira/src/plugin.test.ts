import type { PluginCallContext } from "@plotroom/plugin-sdk";
import { describe, expect, it } from "vitest";

import { epicChildrenResolvedCheck, issueInStatusCheck } from "./conditions.js";
import {
  parseCollectionMembers,
  readDocumentText,
  readIssue,
  ticketExternalId,
} from "./model.js";
import {
  createEpicProducer,
  createIssueProducer,
  createWorkflowProducer,
} from "./producers.js";
import {
  AGENT_CONTENT_MAX_BYTES,
  cap,
  createJiraCardRenderer,
  createJiraContentRenderer,
  EXPAND_CARD_ACTION_ID,
  TRANSITION_CARD_ACTION_ID,
} from "./renderers.js";
import { parseExternalId, parseJiraScope } from "./scope.js";
import { createJiraTools } from "./tools.js";
import {
  createRecordedJira,
  FIXTURE_ACCOUNT_ID,
  FIXTURE_BUG,
  FIXTURE_CREDENTIAL,
  FIXTURE_EPIC,
  FIXTURE_SITE,
  FIXTURE_TICKET,
} from "./testing/jira-fixture.js";
import { JIRA_CREDENTIAL_ID } from "./transport.js";
import { createJiraWriteActions } from "./writes.js";

/**
 * The Jira plugin against a recorded Jira: hermetic, and no path in this file can reach
 * the network. The real worker host is `host.integration.test.ts`.
 */

const permissions = ["jira-api", "jira-credential"];

const contextWith = (
  credentials: Readonly<Record<string, string>>,
): PluginCallContext => ({
  invocationId: "test#1",
  actor: null,
  credentials,
  grants: permissions,
  log: () => undefined,
});

const connected = contextWith({ [JIRA_CREDENTIAL_ID]: FIXTURE_CREDENTIAL });
const unconnected = contextWith({});
const misconfigured = contextWith({
  [JIRA_CREDENTIAL_ID]: "a-token-with-no-email",
});

const scopeOf = (jql: string, limit?: number): string =>
  `site=${FIXTURE_SITE}${limit === undefined ? "" : ` limit=${limit}`} ${jql}`;

const issuesScope = { scope: scopeOf("project = OXY"), externalId: null };

describe("scoping in Jira's own query language (§9.1)", () => {
  it("hands JQL through verbatim, whitespace and all", () => {
    const parsed = parseJiraScope(
      scopeOf("project = OXY AND statusCategory != Done ORDER BY created DESC"),
    );
    if (!parsed.ok) {
      throw new Error(parsed.why);
    }
    expect(parsed.scope).toEqual({
      site: FIXTURE_SITE,
      jql: "project = OXY AND statusCategory != Done ORDER BY created DESC",
      limit: 25,
    });
  });

  it("caps the page size and reads the limit directive", () => {
    const parsed = parseJiraScope(scopeOf("project = OXY", 5000));
    expect(parsed.ok && parsed.scope.limit).toBe(100);
  });

  it("refuses an unparseable scope with what it should have said", () => {
    expect(parseJiraScope(null).ok).toBe(false);
    // No default site: a query with none would go to somebody else's tenant.
    expect(parseJiraScope("project = OXY").ok).toBe(false);
    expect(parseJiraScope("site=acme.atlassian.net").ok).toBe(false);
    expect(parseJiraScope("site=not_a_host project = OXY").ok).toBe(false);
  });

  it("does not validate JQL — that is Jira's grammar, and Jira refuses it (§9.2)", async () => {
    const recorded = createRecordedJira();
    const parsed = parseJiraScope(scopeOf("nonsense !! query"));
    expect(parsed.ok).toBe(true);

    const read = await createIssueProducer(
      recorded.transport,
      permissions,
    ).read(
      { scope: scopeOf("nonsense !! query"), externalId: null },
      connected,
    );
    expect(read.objects).toEqual([]);
    expect(read.unavailable[0]?.why).toContain("Error in the JQL Query");
  });

  it("reads its own external ids back, so a refresh names one object (§3.1)", () => {
    expect(parseExternalId(`jira:ticket:${FIXTURE_SITE}/OXY-2`)).toEqual({
      site: FIXTURE_SITE,
      key: "OXY-2",
      kind: "ticket",
    });
    expect(parseExternalId(`jira:collection:${FIXTURE_SITE}/OXY-1`)?.kind).toBe(
      "collection",
    );
    expect(parseExternalId("github:ticket:acme/app#7")).toBeNull();
    expect(parseExternalId(`jira:ticket:${FIXTURE_SITE}/oxy-2`)).toBeNull();
  });
});

describe("concepts are present or absent, never degraded (§3.1, §9.3)", () => {
  it("produces issues as tickets", async () => {
    const recorded = createRecordedJira();
    const read = await createIssueProducer(
      recorded.transport,
      permissions,
    ).read(issuesScope, connected);
    expect(read.unavailable).toEqual([]);
    expect(read.objects.map((one) => one.externalId)).toEqual([
      `jira:ticket:${FIXTURE_SITE}/OXY-1`,
      `jira:ticket:${FIXTURE_SITE}/OXY-2`,
      `jira:ticket:${FIXTURE_SITE}/OXY-3`,
      `jira:ticket:${FIXTURE_SITE}/OXY-9`,
    ]);
    const ticket = read.objects[1];
    expect(ticket?.kind).toBe("ticket");
    // The description arrives as prose, not as Atlassian Document Format JSON.
    expect(ticket?.renderings.agentContent).toContain(
      "The canvas must refuse an illegal edge",
    );
    expect(ticket?.renderings.agentContent).toContain("Status: To Do");
    expect(ticket?.renderings.agentContent).toContain(
      `Link: https://${FIXTURE_SITE}/browse/OXY-2`,
    );
  });

  it("refreshes one issue from its external id alone, with no scope (§9.1)", async () => {
    const recorded = createRecordedJira();
    const read = await createIssueProducer(
      recorded.transport,
      permissions,
    ).read(
      { scope: null, externalId: `jira:ticket:${FIXTURE_SITE}/OXY-3` },
      connected,
    );
    expect(read.objects).toHaveLength(1);
    expect(read.objects[0]?.title).toContain("OXY-3");
  });

  it("reports a page as a page rather than letting it stand in for the query (principle 12)", async () => {
    const recorded = createRecordedJira();
    const read = await createIssueProducer(
      recorded.transport,
      permissions,
    ).read({ scope: scopeOf("project = OXY", 2), externalId: null }, connected);
    expect(read.objects).toHaveLength(2);
    expect(read.unavailable[0]?.why).toContain(
      "more issues matching this query",
    );
  });

  it("names a missing credential as a connection problem, not as missing data (§9.3)", async () => {
    const recorded = createRecordedJira();
    const read = await createIssueProducer(
      recorded.transport,
      permissions,
    ).read(issuesScope, unconnected);
    expect(read.objects).toEqual([]);
    expect(read.unavailable[0]?.why).toContain("connection problem");
  });

  it("names a credential that is not a Jira Cloud pair, saying what it must be", async () => {
    const recorded = createRecordedJira();
    const read = await createIssueProducer(
      recorded.transport,
      permissions,
    ).read(issuesScope, misconfigured);
    expect(read.objects).toEqual([]);
    expect(read.unavailable[0]?.why).toContain('"email:token"');
  });

  it("reports an unreachable site as unreachable", async () => {
    const recorded = createRecordedJira();
    const read = await createIssueProducer(
      recorded.transport,
      permissions,
    ).read(
      { scope: "site=other.atlassian.net project = OXY", externalId: null },
      connected,
    );
    expect(read.objects).toEqual([]);
    expect(read.unavailable[0]?.why).toContain("could not be reached");
  });

  it("refuses a scope with no site rather than guessing one", async () => {
    const recorded = createRecordedJira();
    const read = await createIssueProducer(
      recorded.transport,
      permissions,
    ).read({ scope: "project = OXY", externalId: null }, connected);
    expect(read.unavailable[0]?.why).toContain("no default Jira site");
    expect(recorded.requests).toEqual([]);
  });
});

describe("an epic and its children (§9.4, §3.1)", () => {
  const epicScope = {
    scope: scopeOf("issuetype = Epic AND project = OXY"),
    externalId: null,
  };

  it("produces the epic as a collection and every child as its own ticket", async () => {
    const recorded = createRecordedJira();
    const read = await createEpicProducer(recorded.transport, permissions).read(
      epicScope,
      connected,
    );
    expect(read.unavailable).toEqual([]);

    const collection = read.objects.find((one) => one.kind === "collection");
    if (collection === undefined) {
      throw new Error("no collection was produced");
    }
    // "presented as one thing with a count" (§3.1).
    expect(collection.title).toBe("OXY-1 Path claims (2 children)");
    expect(collection.externalId).toBe(`jira:collection:${FIXTURE_SITE}/OXY-1`);

    // Membership is stated as content plus co-produced members, joined by external
    // id — the least-inventive representation the contract can express, since core's
    // `collection` kind has no membership model yet.
    expect(parseCollectionMembers(collection.renderings.agentContent)).toEqual([
      ticketExternalId({ site: FIXTURE_SITE, key: FIXTURE_TICKET }),
      ticketExternalId({ site: FIXTURE_SITE, key: FIXTURE_BUG }),
    ]);
    const members = read.objects.filter((one) => one.kind === "ticket");
    expect(members.map((one) => one.externalId)).toEqual(
      parseCollectionMembers(collection.renderings.agentContent),
    );
  });

  it("refreshes one epic from its collection id alone, with no scope (§9.1)", async () => {
    const recorded = createRecordedJira();
    const read = await createEpicProducer(recorded.transport, permissions).read(
      {
        scope: null,
        externalId: `jira:collection:${FIXTURE_SITE}/${FIXTURE_EPIC}`,
      },
      connected,
    );
    const collection = read.objects.find((one) => one.kind === "collection");
    expect(collection?.title).toBe("OXY-1 Path claims (2 children)");
    expect(read.objects.filter((one) => one.kind === "ticket")).toHaveLength(2);
  });

  it("says so when the membership it read is not all of it (principle 12)", async () => {
    const recorded = createRecordedJira();
    const read = await createEpicProducer(recorded.transport, permissions).read(
      {
        scope: scopeOf("issuetype = Epic AND project = OXY", 1),
        externalId: null,
      },
      connected,
    );
    const collection = read.objects.find((one) => one.kind === "collection");
    expect(collection?.renderings.summary).toContain("were not read");
    expect(collection?.renderings.agentContent).toContain("incomplete");
  });

  it("produces no collection at all when membership could not be read (§3.1)", async () => {
    const recorded = createRecordedJira();
    // A transport that answers the epic search and then refuses the children read.
    let reads = 0;
    const flaky = async (request: Parameters<typeof recorded.transport>[0]) => {
      reads += 1;
      return reads === 1
        ? recorded.transport(request)
        : { status: 500, body: JSON.stringify({ errorMessages: ["boom"] }) };
    };
    const read = await createEpicProducer(flaky, permissions).read(
      epicScope,
      connected,
    );
    expect(read.objects).toEqual([]);
    expect(read.unavailable[0]?.externalId).toBe(
      `jira:collection:${FIXTURE_SITE}/OXY-1`,
    );
    expect(read.unavailable[0]?.why).toContain("boom");
  });
});

describe("statuses and transitions as content (§9.4)", () => {
  it("produces the workflow available now, asked for rather than derived", async () => {
    const recorded = createRecordedJira();
    const read = await createWorkflowProducer(
      recorded.transport,
      permissions,
    ).read(
      { scope: scopeOf(`issue = ${FIXTURE_BUG}`), externalId: null },
      connected,
    );
    const workflow = read.objects[0];
    expect(workflow?.kind).toBe("document");
    expect(workflow?.externalId).toBe(`jira:document:${FIXTURE_SITE}/OXY-3`);
    expect(workflow?.renderings.agentContent).toContain(
      "Current status: In Progress",
    );
    expect(workflow?.renderings.agentContent).toContain(
      "Start review (id 31) → In Review",
    );
  });

  it("says a terminal status offers nothing rather than inventing a transition", async () => {
    const recorded = createRecordedJira();
    const read = await createWorkflowProducer(
      recorded.transport,
      permissions,
    ).read({ scope: scopeOf("issue = OXY-9"), externalId: null }, connected);
    expect(read.objects[0]?.renderings.agentContent).toContain(
      "offers this account no transition from here",
    );
  });
});

describe("writes declare their own reversibility (§9.2, §6.6)", () => {
  it("declares one per action, honestly", () => {
    const recorded = createRecordedJira();
    const actions = createJiraWriteActions(recorded.transport, permissions);
    expect(
      actions.map((action) => `${action.id}:${action.reversibility}`),
    ).toEqual([
      "comment:reversible",
      "transition:reversible",
      "assign:reversible",
      "update-summary:reversible",
      // An issue can be deleted, but its key is never reissued: the author cannot
      // tell, and `unknown` is treated as irreversible (principle 7).
      "create-issue:unknown",
    ]);
  });

  it("reads a comment back, so what is returned is what Jira now says (§9.2)", async () => {
    const recorded = createRecordedJira();
    const [comment] = createJiraWriteActions(recorded.transport, permissions);
    const result = await comment?.perform(
      { site: FIXTURE_SITE, key: FIXTURE_TICKET, body: "on it" },
      connected,
    );
    expect(result?.ok).toBe(true);
    expect(result?.readBack?.externalId).toBe(
      `jira:ticket:${FIXTURE_SITE}/OXY-2`,
    );
    // The read-back really did re-read something that changed.
    expect(result?.readBack?.renderings.agentContent).toContain(
      "Comments so far: 1",
    );
  });

  it("reports where a transition actually landed, not where it was aimed (§9.2)", async () => {
    const recorded = createRecordedJira();
    const actions = createJiraWriteActions(recorded.transport, permissions);
    const transition = actions[1];
    // OXY-3 is In Progress; id 31 asks for In Review, and the recorded Jira's
    // automation rule lands it in Blocked instead.
    const result = await transition?.perform(
      { site: FIXTURE_SITE, key: FIXTURE_BUG, transitionId: "31" },
      connected,
    );
    expect(result?.ok).toBe(true);
    expect(result?.message).toContain("transition 31");
    expect(result?.readBack?.renderings.card).toContain("Blocked");
    expect(result?.readBack?.renderings.card).not.toContain("In Review");
  });

  it("says when the workflow offers no way back, which the declaration cannot", async () => {
    const recorded = createRecordedJira();
    const actions = createJiraWriteActions(recorded.transport, permissions);
    const transition = actions[1];
    const result = await transition?.perform(
      { site: FIXTURE_SITE, key: FIXTURE_BUG, transitionId: "41" },
      connected,
    );
    expect(result?.readBack?.renderings.card).toContain("Done");
    expect(result?.message).toContain("no transition back to In Progress");
  });

  it("names the transition back when there is one", async () => {
    const recorded = createRecordedJira();
    const actions = createJiraWriteActions(recorded.transport, permissions);
    const result = await actions[1]?.perform(
      { site: FIXTURE_SITE, key: FIXTURE_TICKET, transitionId: "21" },
      connected,
    );
    expect(result?.message).toContain("transition back to To Do exists");
  });

  it("passes a rejection's own error text through unedited (§9.2)", async () => {
    const recorded = createRecordedJira();
    const actions = createJiraWriteActions(recorded.transport, permissions);
    const invalid = await actions[1]?.perform(
      // OXY-2 is To Do, from which 41 is not a valid transition.
      { site: FIXTURE_SITE, key: FIXTURE_TICKET, transitionId: "41" },
      connected,
    );
    expect(invalid?.ok).toBe(false);
    expect(invalid?.message).toContain("is not valid from status To Do");
    expect(invalid?.readBack).toBeNull();

    const assign = await actions[2]?.perform(
      { site: FIXTURE_SITE, key: FIXTURE_TICKET, accountId: "acc-nobody" },
      connected,
    );
    expect(assign?.ok).toBe(false);
    expect(assign?.message).toContain("Specified user does not exist");
  });

  it("assigns and unassigns, reading each back", async () => {
    const recorded = createRecordedJira();
    const actions = createJiraWriteActions(recorded.transport, permissions);
    const assigned = await actions[2]?.perform(
      {
        site: FIXTURE_SITE,
        key: FIXTURE_TICKET,
        accountId: FIXTURE_ACCOUNT_ID,
      },
      connected,
    );
    expect(assigned?.readBack?.renderings.summary).toContain(
      "assigned to Andy Hite",
    );
    const unassigned = await actions[2]?.perform(
      { site: FIXTURE_SITE, key: FIXTURE_TICKET },
      connected,
    );
    expect(unassigned?.readBack?.renderings.summary).toContain("unassigned");
  });

  it("retitles an issue and reads the new title back", async () => {
    const recorded = createRecordedJira();
    const actions = createJiraWriteActions(recorded.transport, permissions);
    const result = await actions[3]?.perform(
      {
        site: FIXTURE_SITE,
        key: FIXTURE_TICKET,
        summary: "Refuse them harder",
      },
      connected,
    );
    expect(result?.readBack?.title).toBe("OXY-2 Refuse them harder");
  });

  it("creates an issue under an epic and reads the new key back", async () => {
    const recorded = createRecordedJira();
    const actions = createJiraWriteActions(recorded.transport, permissions);
    const created = await actions[4]?.perform(
      {
        site: FIXTURE_SITE,
        project: "OXY",
        issueType: "Task",
        summary: "Write the landed note",
        parent: FIXTURE_EPIC,
      },
      connected,
    );
    expect(created?.ok).toBe(true);
    expect(created?.readBack?.title).toContain("Write the landed note");
    expect(created?.readBack?.renderings.agentContent).toContain(
      "Parent: OXY-1",
    );
  });

  it("refuses a write with no site, and one with no issue key", async () => {
    const recorded = createRecordedJira();
    const actions = createJiraWriteActions(recorded.transport, permissions);
    const noSite = await actions[0]?.perform(
      { key: FIXTURE_TICKET, body: "hello" },
      connected,
    );
    expect(noSite?.ok).toBe(false);
    expect(noSite?.message).toContain("no default site");

    const noKey = await actions[0]?.perform(
      { site: FIXTURE_SITE, key: "not-a-key", body: "hello" },
      connected,
    );
    expect(noKey?.message).toContain("OXY-2982");
    expect(recorded.requests).toEqual([]);
  });
});

describe("agent tools are the write actions, not a second implementation (§10.1)", () => {
  const toolsOf = (transport: Parameters<typeof createJiraTools>[0]) => {
    const writes = createJiraWriteActions(transport, permissions);
    return createJiraTools(transport, writes, permissions);
  };

  it("names each write action it delegates to, so §6.6 reads one declaration", () => {
    const recorded = createRecordedJira();
    const tools = toolsOf(recorded.transport);
    const writeTools = tools.filter((tool) => tool.requires.mutates);
    expect(writeTools.map((tool) => tool.requires.writeActionId)).toEqual([
      "comment",
      "transition",
      "assign",
      "update-summary",
      "create-issue",
    ]);
    for (const tool of tools.filter((one) => !one.requires.mutates)) {
      expect(tool.requires.writeActionId).toBeNull();
    }
  });

  it("reads a ticket, a JQL search, and the transitions Jira will accept", async () => {
    const recorded = createRecordedJira();
    const tools = toolsOf(recorded.transport);
    const read = tools.find((tool) => tool.name === "jira_read_ticket");
    const answered = await read?.call(
      { site: FIXTURE_SITE, key: FIXTURE_TICKET },
      connected,
    );
    expect(answered?.ok).toBe(true);
    expect(answered?.content).toContain("OXY-2");

    const search = tools.find((tool) => tool.name === "jira_search");
    const found = await search?.call(
      { site: FIXTURE_SITE, jql: "project = OXY", limit: 2 },
      connected,
    );
    expect(found?.content).toContain("more matches than the limit of 2");

    const transitions = tools.find(
      (tool) => tool.name === "jira_read_transitions",
    );
    const workflow = await transitions?.call(
      { site: FIXTURE_SITE, key: FIXTURE_BUG },
      connected,
    );
    expect(workflow?.content).toContain("Start review (id 31)");
  });

  it("refuses a read with no site or no key, saying which", async () => {
    const recorded = createRecordedJira();
    const tools = toolsOf(recorded.transport);
    const read = tools.find((tool) => tool.name === "jira_read_ticket");
    expect((await read?.call({ key: FIXTURE_TICKET }, connected))?.ok).toBe(
      false,
    );
    expect(
      (await read?.call({ site: FIXTURE_SITE, key: "nope" }, connected))
        ?.content,
    ).toContain("OXY-2982");
    const search = tools.find((tool) => tool.name === "jira_search");
    expect(
      (await search?.call({ site: FIXTURE_SITE, jql: "  " }, connected))
        ?.content,
    ).toContain("JQL");
  });

  it("hands back what the write action said, including the read-back", async () => {
    const recorded = createRecordedJira();
    const tools = toolsOf(recorded.transport);
    const comment = tools.find((tool) => tool.name === "jira_comment");
    const result = await comment?.call(
      { site: FIXTURE_SITE, key: FIXTURE_TICKET, body: "looks good" },
      connected,
    );
    expect(result?.ok).toBe(true);
    expect(result?.content).toContain("Read back:");
  });
});

describe("condition checks: proof, and the third answer (principle 3)", () => {
  it("answers met and unmet from Jira's own status and category", async () => {
    const recorded = createRecordedJira();
    const check = issueInStatusCheck(recorded.transport, permissions);
    const unmet = await check.check(
      { site: FIXTURE_SITE, key: FIXTURE_TICKET, status: "done" },
      connected,
    );
    expect(unmet.state).toBe("unmet");
    expect(unmet.evidence).toContain("To Do");

    const met = await check.check(
      { site: FIXTURE_SITE, key: "OXY-9", status: "done" },
      connected,
    );
    expect(met.state).toBe("met");

    const byName = await check.check(
      { site: FIXTURE_SITE, key: FIXTURE_BUG, status: "in progress" },
      connected,
    );
    expect(byName.state).toBe("met");
  });

  it("answers unknown — not unmet — when nothing could be checked", async () => {
    const recorded = createRecordedJira();
    const check = issueInStatusCheck(recorded.transport, permissions);
    expect((await check.check({}, connected)).state).toBe("unknown");
    expect(
      (
        await check.check(
          { site: FIXTURE_SITE, key: FIXTURE_TICKET, status: "done" },
          unconnected,
        )
      ).state,
    ).toBe("unknown");
    const missing = await check.check(
      { site: FIXTURE_SITE, key: "OXY-404", status: "done" },
      connected,
    );
    expect(missing.state).toBe("unknown");
    expect(missing.evidence).toContain("do not have permission");
  });

  it("refuses to call an empty epic finished (principle 3)", async () => {
    const recorded = createRecordedJira();
    const check = epicChildrenResolvedCheck(recorded.transport, permissions);
    const empty = await check.check(
      { site: FIXTURE_SITE, epic: "OXY-9" },
      connected,
    );
    expect(empty.state).toBe("unknown");
    expect(empty.evidence).toContain("proved nothing");

    const open = await check.check(
      { site: FIXTURE_SITE, epic: FIXTURE_EPIC },
      connected,
    );
    expect(open.state).toBe("unmet");
    expect(open.evidence).toContain("OXY-2");
  });

  it("answers met once every child is done", async () => {
    const recorded = createRecordedJira();
    const actions = createJiraWriteActions(recorded.transport, permissions);
    const transition = actions[1];
    // OXY-2: To Do → In Progress → Done. OXY-3: In Progress → Done.
    await transition?.perform(
      { site: FIXTURE_SITE, key: FIXTURE_TICKET, transitionId: "21" },
      connected,
    );
    await transition?.perform(
      { site: FIXTURE_SITE, key: FIXTURE_TICKET, transitionId: "41" },
      connected,
    );
    await transition?.perform(
      { site: FIXTURE_SITE, key: FIXTURE_BUG, transitionId: "41" },
      connected,
    );
    const check = epicChildrenResolvedCheck(recorded.transport, permissions);
    const answer = await check.check(
      { site: FIXTURE_SITE, epic: FIXTURE_EPIC },
      connected,
    );
    expect(answer.state).toBe("met");
  });
});

describe("renderers (§3.2, §10.1)", () => {
  it("reports a truncation rather than dropping content (principle 12)", () => {
    const capped = cap("x".repeat(AGENT_CONTENT_MAX_BYTES + 500), "too long");
    expect(capped.truncated?.omittedBytes).toBe(500);
    expect(cap("short", "why").truncated).toBeNull();
  });

  it("renders what's new, and the whole thing when the delta is bigger (§3.2)", async () => {
    const recorded = createRecordedJira();
    const read = await createIssueProducer(
      recorded.transport,
      permissions,
    ).read(
      { scope: scopeOf(`issue = ${FIXTURE_TICKET}`), externalId: null },
      connected,
    );
    const ticket = read.objects[0];
    if (ticket === undefined) {
      throw new Error("no ticket");
    }
    const renderer = createJiraContentRenderer();
    const delta = renderer.renderDelta(
      {
        ...ticket,
        renderings: { ...ticket.renderings, agentContent: "Status: To Do" },
      },
      ticket,
      connected,
    ) as { content: string };
    expect(delta.content.length).toBeGreaterThan(0);

    const same = renderer.renderDelta(ticket, ticket, connected) as {
      content: string;
    };
    expect(same.content).toContain("reads the same");
  });

  it("offers expand on a collection and a §6.6-gated transition on a ticket", async () => {
    const recorded = createRecordedJira();
    const read = await createEpicProducer(recorded.transport, permissions).read(
      {
        scope: scopeOf("issuetype = Epic AND project = OXY"),
        externalId: null,
      },
      connected,
    );
    const renderer = createJiraCardRenderer();
    const collection = read.objects.find((one) => one.kind === "collection");
    const epicCard = renderer.renderCard(
      collection as NonNullable<typeof collection>,
      "compact",
      connected,
    ) as { actions: readonly { id: string; writeActionId: string | null }[] };
    expect(epicCard.actions[0]?.id).toBe(EXPAND_CARD_ACTION_ID);
    // Expanding writes nothing to Jira, so there is no write action behind it.
    expect(epicCard.actions[0]?.writeActionId).toBeNull();

    const ticket = read.objects.find((one) => one.kind === "ticket");
    const ticketCard = renderer.renderCard(
      ticket as NonNullable<typeof ticket>,
      "expanded",
      connected,
    ) as { actions: readonly { id: string; writeActionId: string | null }[] };
    expect(ticketCard.actions[0]?.id).toBe(TRANSITION_CARD_ACTION_ID);
    expect(ticketCard.actions[0]?.writeActionId).toBe("transition");
  });
});

describe("reading Jira's payloads", () => {
  it("produces no object at all for a payload with no key (§3.1)", () => {
    expect(readIssue({ fields: { summary: "orphan" } })).toBeNull();
    expect(readIssue(null)).toBeNull();
    expect(readIssue([])).toBeNull();
  });

  it("flattens Atlassian Document Format without dropping text", () => {
    expect(
      readDocumentText({
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "first" },
              { type: "text", text: " line" },
            ],
          },
          { type: "paragraph", content: [{ type: "text", text: "second" }] },
        ],
      }),
    ).toBe("first line\nsecond");
    // v2 payloads and rendered fields are plain strings.
    expect(readDocumentText("already prose")).toBe("already prose");
    expect(readDocumentText(undefined)).toBe("");
  });
});
