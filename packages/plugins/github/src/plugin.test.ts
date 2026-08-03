import type { PluginCallContext, WriteAction } from "@plotroom/plugin-sdk";
import { describe, expect, it } from "vitest";

import { checksGreenCheck, pullRequestExistsCheck } from "./conditions.js";
import { readIssue, readPullRequest } from "./model.js";
import {
  createPullRequestProducer,
  createRepositoryProducer,
  createReviewProducer,
  createTicketProducer,
} from "./producers.js";
import {
  cap,
  CLONE_CARD_ACTION_ID,
  cloneUrlOf,
  createGitHubCardRenderer,
  createGitHubContentRenderer,
} from "./renderers.js";
import { parseExternalId, parseGitHubScope } from "./scope.js";
import { createGitHubTools } from "./tools.js";
import {
  createRecordedGitHub,
  FIXTURE_HEAD_SHA,
  FIXTURE_TOKEN,
  FIXTURE_UNCHECKED_SHA,
} from "./testing/github-fixture.js";
import { GITHUB_CREDENTIAL_ID } from "./transport.js";
import { createGitHubWriteActions } from "./writes.js";

/**
 * The GitHub plugin against a recorded GitHub: hermetic, and no path in this file can
 * reach the network. The real worker host is `host.integration.test.ts`.
 */

const permissions = ["github-api", "github-token"];

const contextWith = (
  credentials: Readonly<Record<string, string>>,
): PluginCallContext => ({
  invocationId: "test#1",
  actor: null,
  credentials,
  grants: permissions,
  log: () => undefined,
});

const connected = contextWith({ [GITHUB_CREDENTIAL_ID]: FIXTURE_TOKEN });
const unconnected = contextWith({});

describe("scoping in GitHub's own vocabulary (§9.1)", () => {
  it("reads repo, state and a capped limit", () => {
    const parsed = parseGitHubScope("repo:acme/app state:closed limit:500");
    if (!parsed.ok) {
      throw new Error(parsed.why);
    }
    expect(parsed.scope).toEqual({
      repository: { owner: "acme", name: "app" },
      state: "closed",
      limit: 100,
    });
  });

  it("refuses an unparseable scope with what it should have said", () => {
    expect(parseGitHubScope(null).ok).toBe(false);
    expect(parseGitHubScope("repo:not-a-repo").ok).toBe(false);
    expect(parseGitHubScope("repo:acme/app state:whenever").ok).toBe(false);
    expect(parseGitHubScope("repo:acme/app milestone:3").ok).toBe(false);
    // The grammar is GitHub's own `key:value`; `limit=3` is refused rather than
    // silently read as a repository name.
    expect(parseGitHubScope("repo:acme/app limit=3").ok).toBe(false);
  });

  it("reads its own external ids back, so a refresh names one object (§3.1)", () => {
    expect(parseExternalId("github:pull_request:acme/app#12")).toEqual({
      repository: { owner: "acme", name: "app" },
      number: 12,
      reviewId: null,
    });
    expect(parseExternalId("github:review:acme/app#12:9001")?.reviewId).toBe(
      9001,
    );
    expect(parseExternalId("github:document:acme/app")?.number).toBeNull();
    expect(parseExternalId("jira:ticket:OXY-1")).toBeNull();
  });
});

describe("concepts are present or absent, never degraded (§3.1, §9.3)", () => {
  it("produces pull requests, reviews, tickets and repository metadata", async () => {
    const recorded = createRecordedGitHub();
    const scope = { scope: "repo:acme/app", externalId: null };

    const pulls = await createPullRequestProducer(
      recorded.transport,
      permissions,
    ).read(scope, connected);
    expect(pulls.unavailable).toEqual([]);
    expect(pulls.objects[0]?.kind).toBe("pull_request");
    expect(pulls.objects[0]?.externalId).toBe(
      "github:pull_request:acme/app#12",
    );

    const reviews = await createReviewProducer(
      recorded.transport,
      permissions,
    ).read({ scope: "repo:acme/app pull:12", externalId: null }, connected);
    expect(reviews.objects[0]?.kind).toBe("review");
    expect(reviews.objects[0]?.title).toContain("changes_requested");

    const tickets = await createTicketProducer(
      recorded.transport,
      permissions,
    ).read(scope, connected);
    // GitHub's issue list includes pull requests; a ticket is not one of those.
    expect(tickets.objects).toHaveLength(1);
    expect(tickets.objects[0]?.kind).toBe("ticket");
    expect(tickets.objects[0]?.externalId).toBe("github:ticket:acme/app#7");

    const repository = await createRepositoryProducer(
      recorded.transport,
      permissions,
    ).read(scope, connected);
    expect(repository.objects[0]?.kind).toBe("document");
    expect(repository.objects[0]?.renderings.agentContent).toContain(
      "Default branch: main",
    );
  });

  it("reports a missing connection as a connection problem, never as no data (§9.3)", async () => {
    const recorded = createRecordedGitHub();
    const read = await createPullRequestProducer(
      recorded.transport,
      permissions,
    ).read({ scope: "repo:acme/app", externalId: null }, unconnected);
    expect(read.objects).toEqual([]);
    expect(read.unavailable[0]?.why).toContain("connection is not usable");
    // Nothing was even attempted: there was no identity to attempt it with.
    expect(recorded.requests).toEqual([]);
  });

  it("reports GitHub's refusal as unavailable rather than producing an object", async () => {
    const recorded = createRecordedGitHub();
    const read = await createRepositoryProducer(
      recorded.transport,
      permissions,
    ).read({ scope: "repo:acme/missing", externalId: null }, connected);
    expect(read.objects).toEqual([]);
    expect(read.unavailable[0]?.why).toContain("404");
    expect(read.unavailable[0]?.why).toContain("Not Found");
  });

  it("produces no object at all from a payload with no identity in it", () => {
    expect(readPullRequest({ title: "no number" })).toBeNull();
    expect(readIssue("not an object")).toBeNull();
  });
});

describe("writes declare reversibility and read back (§9.2, §6.6)", () => {
  const actionsOf = (transport: ReturnType<typeof createRecordedGitHub>) =>
    createGitHubWriteActions(transport.transport, permissions);
  const find = (actions: readonly WriteAction[], id: string): WriteAction => {
    const action = actions.find((one) => one.id === id);
    if (action === undefined) {
      throw new Error(`no ${id}`);
    }
    return action;
  };

  it("declares one reversibility per action, and merge as irreversible", () => {
    const recorded = createRecordedGitHub();
    expect(
      Object.fromEntries(
        actionsOf(recorded).map((action) => [action.id, action.reversibility]),
      ),
    ).toEqual({
      comment: "reversible",
      "request-review": "reversible",
      "close-issue": "reversible",
      merge: "irreversible",
    });
  });

  it("re-reads after a transition instead of assuming what it asked for", async () => {
    const recorded = createRecordedGitHub();
    const actions = actionsOf(recorded);
    const result = await find(actions, "close-issue").perform(
      { repository: "acme/app", number: 7, state: "closed" },
      connected,
    );
    expect(result.ok).toBe(true);
    expect(result.readBack?.renderings.summary).toContain("closed");
    // The read-back is a real second request, not a copy of what was sent.
    expect(
      recorded.requests.filter(
        (request) =>
          request.method === "GET" &&
          request.url.endsWith("/repos/acme/app/issues/7"),
      ),
    ).toHaveLength(1);
  });

  it("passes GitHub's own rejection text through unedited (§9.2)", async () => {
    const recorded = createRecordedGitHub();
    const result = await find(actionsOf(recorded), "merge").perform(
      { repository: "acme/app", number: 13 },
      connected,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Pull Request is not mergeable");
    expect(result.readBack).toBeNull();
  });

  it("refuses a write with no connection, and one with no target", async () => {
    const recorded = createRecordedGitHub();
    const comment = find(actionsOf(recorded), "comment");
    expect(
      (
        await comment.perform(
          { repository: "acme/app", number: 7, body: "x" },
          unconnected,
        )
      ).message,
    ).toContain("connection is not usable");
    expect((await comment.perform({ body: "x" }, connected)).ok).toBe(false);
    expect(recorded.requests).toEqual([]);
  });
});

describe("agent tools are the same writes, not a second implementation (principle 8)", () => {
  it("names the write action each mutating tool performs", () => {
    const recorded = createRecordedGitHub();
    const writes = createGitHubWriteActions(recorded.transport, permissions);
    const tools = createGitHubTools(recorded.transport, writes, permissions);
    expect(
      tools.map((tool) => [tool.name, tool.requires.writeActionId]),
    ).toEqual([
      ["github_read_pull_request", null],
      ["github_comment", "comment"],
      ["github_transition_issue", "close-issue"],
      ["github_merge_pull_request", "merge"],
    ]);
    expect(tools.map((tool) => tool.requires.mutates)).toEqual([
      false,
      true,
      true,
      true,
    ]);
  });

  it("performs the write and reports the read-back to the calling session", async () => {
    const recorded = createRecordedGitHub();
    const writes = createGitHubWriteActions(recorded.transport, permissions);
    const tools = createGitHubTools(recorded.transport, writes, permissions);
    const comment = tools.find((tool) => tool.name === "github_comment");
    if (comment === undefined) {
      throw new Error("no comment tool");
    }
    const result = await comment.call(
      { repository: "acme/app", number: 7, body: "looks good" },
      connected,
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain("commented on acme/app#7");
    expect(result.content).toContain("Read back:");
  });
});

describe("condition checks answer met, unmet and unknown (principle 3)", () => {
  it("finds an open pull request from a branch, and says when there is none", async () => {
    const recorded = createRecordedGitHub();
    const check = pullRequestExistsCheck(recorded.transport, permissions);
    const met = await check.check(
      { repository: "acme/app", branch: "feat/mid-drag" },
      connected,
    );
    expect(met.state).toBe("met");
    expect(met.evidence).toContain("acme/app#12");

    const unmet = await check.check(
      { repository: "acme/app", branch: "feat/nothing" },
      connected,
    );
    expect(unmet.state).toBe("unmet");

    const unknown = await check.check(
      { repository: "acme/app", branch: "feat/mid-drag" },
      unconnected,
    );
    expect(unknown.state).toBe("unknown");
  });

  it("treats a commit nothing checked as unknown, never as green", async () => {
    const recorded = createRecordedGitHub();
    const check = checksGreenCheck(recorded.transport, permissions);
    expect(
      (
        await check.check(
          { repository: "acme/app", ref: FIXTURE_HEAD_SHA },
          connected,
        )
      ).state,
    ).toBe("met");
    expect(
      (await check.check({ repository: "acme/app", ref: "failing" }, connected))
        .state,
    ).toBe("unmet");
    const nothing = await check.check(
      { repository: "acme/app", ref: FIXTURE_UNCHECKED_SHA },
      connected,
    );
    expect(nothing.state).toBe("unknown");
    expect(nothing.evidence).toContain("no check runs");
  });
});

describe("renderers: deltas, truncation, and clone-from-a-pull-request (§3.2, §3.4)", () => {
  const object = {
    kind: "pull_request" as const,
    externalId: "github:pull_request:acme/app#12",
    title: "acme/app#12 Refuse illegal edges mid-drag",
    renderings: {
      card: "#12 Refuse illegal edges mid-drag — open",
      summary: "acme/app#12 — open",
      agentContent: "State: open\nClone: https://github.com/acme/app.git",
    },
  };

  it("reports what's new rather than re-rendering the whole object", () => {
    const renderer = createGitHubContentRenderer();
    const next = {
      ...object,
      renderings: {
        ...object.renderings,
        agentContent:
          "State: open\nClone: https://github.com/acme/app.git\nRequested reviewers: reviewer",
      },
    };
    const delta = renderer.renderDelta(object, next, connected);
    expect("content" in delta ? delta.content : "").toContain(
      "Requested reviewers: reviewer",
    );
    expect("content" in delta ? delta.content : "").toContain("## New");
  });

  it("stands the full content in when the delta is larger than it (§3.2)", () => {
    const renderer = createGitHubContentRenderer();
    const previous = {
      ...object,
      renderings: { ...object.renderings, agentContent: "a\nb\nc" },
    };
    const next = {
      ...object,
      renderings: { ...object.renderings, agentContent: "x" },
    };
    const delta = renderer.renderDelta(previous, next, connected);
    expect("content" in delta ? delta.content : "").toBe("x");
  });

  it("says how many bytes it dropped rather than dropping them quietly", () => {
    const capped = cap("y".repeat(200_000), "too long");
    expect(capped.truncated?.omittedBytes).toBeGreaterThan(0);
    expect(cap("short", "why").truncated).toBeNull();
  });

  it("offers clone-from-a-pull-request on the card, with no write action behind it", () => {
    const card = createGitHubCardRenderer().renderCard(
      object,
      "expanded",
      connected,
    );
    const action = "actions" in card ? card.actions[0] : undefined;
    expect(action?.id).toBe(CLONE_CARD_ACTION_ID);
    // The clone is the host's git over the host's own authentication (§3.4).
    expect(action?.writeActionId).toBeNull();
    expect(cloneUrlOf(object)).toBe("https://github.com/acme/app.git");
  });

  it("offers no clone action on a card that carries no clone url", () => {
    const card = createGitHubCardRenderer().renderCard(
      {
        ...object,
        kind: "ticket",
        renderings: { ...object.renderings, agentContent: "Status: open" },
      },
      "compact",
      connected,
    );
    expect("actions" in card ? card.actions : []).toEqual([]);
  });
});
