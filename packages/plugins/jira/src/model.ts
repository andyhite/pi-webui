/**
 * Jira's JSON, read into the first-class concepts §3.1 already has.
 *
 * **Integrations do not add concepts; they populate the ones that exist.** A Jira
 * issue is a `ticket` ("a unit of requested work: identity in some external system,
 * summary, status, type, assignee, a link out"), an **epic with its children is a
 * `collection`**, and an issue's workflow — the status it is in and the transitions
 * available from there — is a `document`. There is no Jira-shaped kind here and
 * `CONCEPT_KINDS` has no room for one.
 *
 * Reading is deliberately defensive and deliberately **not** lenient about identity: a
 * payload with no issue key produces **no object at all** rather than a half-filled
 * one, because concepts are present or absent, never degraded (§3.1), and the external
 * id is what makes a re-read reconcile rather than duplicate.
 *
 * ## How an epic states its children, and why this way
 *
 * `ProducedObject` is `kind` + `externalId` + `title` + three renderings. It carries no
 * members, no references, and no relationship channel of any kind — and core's
 * `collection` kind has **no membership model yet** (settled by decision 0004,
 * `docs/decisions/0004-collection-membership.md`; implemented by #95). So
 * the least-inventive representation the contract can express is used, and nothing is
 * invented in core:
 *
 * 1. the epic is produced as a `collection` object whose content **lists every child
 *    by its own external id**, one per line, in a documented, parseable form
 *    ({@link MEMBER_LINE}, read back by {@link parseCollectionMembers});
 * 2. **each child is produced as its own `ticket` object in the same read**, so the
 *    members are first-class objects with Jira's own identity, which reconcile on
 *    re-read like any other (§3.1);
 * 3. the join between the two is the external id, and nothing else.
 *
 * That is enough for §3.1's gesture — "the epic's children arrive as a collection, the
 * human expands it, prunes it, and drags four tickets out" — because everything
 * draggable already exists as an object. When #95 lands, these same external
 * ids are the join key, so nothing has to be re-read and no plugin-local
 * membership schema has to be migrated away. Packing a member list into a
 * structured side-channel would have been a second membership model that
 * core would later have to honour, which is exactly the invention decision
 * 0004 settled to avoid.
 */
import type { ProducedObject } from "@plotroom/plugin-sdk";

export interface IssueRef {
  readonly site: string;
  readonly key: string;
}

export const issueUrl = (ref: IssueRef): string =>
  `https://${ref.site}/browse/${ref.key}`;

export const ticketExternalId = (ref: IssueRef): string =>
  `jira:ticket:${ref.site}/${ref.key}`;

export const collectionExternalId = (ref: IssueRef): string =>
  `jira:collection:${ref.site}/${ref.key}`;

export const workflowExternalId = (ref: IssueRef): string =>
  `jira:document:${ref.site}/${ref.key}`;

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

const named = (value: unknown): string => {
  const one = record(value);
  return one === null ? "" : text(one["name"]);
};

const person = (value: unknown): string => {
  const one = record(value);
  return one === null ? "" : text(one["displayName"]);
};

/**
 * Atlassian Document Format, flattened to text.
 *
 * Jira's REST v3 returns a rich-text description as a JSON document rather than a
 * string, and a session needs prose. The walk keeps every text node and every hard
 * break, so nothing is dropped — this is a change of representation, not a summary
 * (principle 12). A plain string is accepted too, because v2 payloads and
 * `renderedFields` both produce one.
 */
export function readDocumentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const doc = record(value);
  if (doc === null) {
    return "";
  }
  const lines: string[] = [];
  const walk = (node: unknown, into: string[]): void => {
    const one = record(node);
    if (one === null) {
      return;
    }
    if (one["type"] === "text") {
      into.push(text(one["text"]));
      return;
    }
    if (one["type"] === "hardBreak") {
      into.push("\n");
      return;
    }
    const children = one["content"];
    if (!Array.isArray(children)) {
      return;
    }
    const block =
      one["type"] === "paragraph" ||
      one["type"] === "heading" ||
      one["type"] === "listItem";
    const target = block ? [] : into;
    for (const child of children) {
      walk(child, target);
    }
    if (block) {
      lines.push(target.join(""));
    }
  };
  walk(doc, lines);
  return lines.join("\n").trim();
}

export interface IssueRead {
  readonly key: string;
  readonly summary: string;
  readonly status: string;
  /** Jira's own three-valued category: `new`, `indeterminate`, `done`. */
  readonly statusCategory: string;
  readonly type: string;
  readonly assignee: string;
  readonly reporter: string;
  readonly priority: string;
  readonly labels: readonly string[];
  readonly resolution: string;
  readonly updated: string;
  readonly parentKey: string | null;
  readonly description: string;
}

export function readIssue(payload: unknown): IssueRead | null {
  const raw = record(payload);
  if (raw === null) {
    return null;
  }
  const key = text(raw["key"]);
  if (key === "") {
    return null;
  }
  const fields = record(raw["fields"]) ?? {};
  const status = record(fields["status"]);
  const parent = record(fields["parent"]);
  return {
    key,
    summary: text(fields["summary"]),
    status: status === null ? "" : text(status["name"]),
    statusCategory:
      status === null ? "" : text(record(status["statusCategory"])?.["key"]),
    type: named(fields["issuetype"]),
    assignee: person(fields["assignee"]),
    reporter: person(fields["reporter"]),
    priority: named(fields["priority"]),
    labels: Array.isArray(fields["labels"])
      ? fields["labels"].map(text).filter((label) => label !== "")
      : [],
    resolution: named(fields["resolution"]),
    updated: text(fields["updated"]),
    parentKey: parent === null ? null : text(parent["key"]) || null,
    description: readDocumentText(fields["description"]),
  };
}

/** True when Jira's own status category says this issue is finished. */
export const isResolved = (issue: IssueRead): boolean =>
  issue.statusCategory === "done";

/** An issue as a **ticket** (§3.1, §9.4) — the concept, not a Jira-shaped one. */
export function ticketObject(site: string, issue: IssueRead): ProducedObject {
  const ref: IssueRef = { site, key: issue.key };
  const title = `${issue.key} ${issue.summary}`;
  return {
    kind: "ticket",
    externalId: ticketExternalId(ref),
    title,
    renderings: {
      card: `${issue.key} ${issue.summary} — ${issue.status}`,
      summary: `${title} — ${issue.status}${
        issue.assignee === ""
          ? ", unassigned"
          : `, assigned to ${issue.assignee}`
      }`,
      agentContent: [
        `# ${title}`,
        "",
        `Status: ${issue.status}${issue.resolution === "" ? "" : ` (${issue.resolution})`}`,
        `Type: ${issue.type}`,
        `Reporter: ${issue.reporter === "" ? "unknown" : issue.reporter}`,
        `Assignee: ${issue.assignee === "" ? "unassigned" : issue.assignee}`,
        issue.priority === "" ? null : `Priority: ${issue.priority}`,
        issue.labels.length === 0 ? null : `Labels: ${issue.labels.join(", ")}`,
        issue.parentKey === null ? null : `Parent: ${issue.parentKey}`,
        issue.updated === "" ? null : `Updated: ${issue.updated}`,
        `Link: ${issueUrl(ref)}`,
        "",
        issue.description,
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
    },
  };
}

/**
 * One member line of a collection's content: the external id first, so the join key is
 * the first thing on the line and {@link parseCollectionMembers} is an anchored match
 * rather than a guess.
 */
export const MEMBER_LINE = /^- (jira:ticket:\S+) — (\S+) \[([^\]]*)\] (.*)$/u;

/** Read a collection's own content back into the external ids of its members. */
export function parseCollectionMembers(content: string): readonly string[] {
  const ids: string[] = [];
  for (const line of content.split("\n")) {
    const match = MEMBER_LINE.exec(line);
    if (match !== null) {
      ids.push(match[1] as string);
    }
  }
  return ids;
}

export interface EpicRead {
  readonly epic: IssueRead;
  readonly children: readonly IssueRead[];
  /**
   * True when Jira has more children than this read asked for. Never silently dropped
   * (principle 12): the collection says so in its own content and its summary.
   */
  readonly childrenIncomplete: boolean;
  /**
   * How many were left out, when Jira said. `null` means Jira reported that there are
   * more without saying how many — which is a different fact from none, and reading it
   * as zero is how a truncation becomes silent.
   */
  readonly omittedChildren: number | null;
}

/**
 * An epic and its children as a **collection** (§3.1, §9.4): "a set of any of the
 * above, presented as one thing with a count".
 *
 * The count is in the title, because §3.1 says a collection is presented with one, and
 * the members are listed in the content by external id (see this module's header).
 */
export function epicCollectionObject(
  site: string,
  read: EpicRead,
): ProducedObject {
  const ref: IssueRef = { site, key: read.epic.key };
  const count = read.children.length;
  const resolved = read.children.filter(isResolved).length;
  const title = `${read.epic.key} ${read.epic.summary} (${count} ${
    count === 1 ? "child" : "children"
  })`;
  const omitted = !read.childrenIncomplete
    ? null
    : `${
        read.omittedChildren === null
          ? "further children"
          : `${read.omittedChildren} further children`
      } were not read: raise the scope's limit= to include them`;
  return {
    kind: "collection",
    externalId: collectionExternalId(ref),
    title,
    renderings: {
      card: `${read.epic.key} ${read.epic.summary} — ${count} ${
        count === 1 ? "child" : "children"
      }, ${resolved} done`,
      summary: [
        `${title} — ${read.epic.status}, ${resolved} of ${count} children done`,
        omitted,
      ]
        .filter((part): part is string => part !== null)
        .join("; "),
      agentContent: [
        `# ${title}`,
        "",
        `Status: ${read.epic.status}`,
        `Type: ${read.epic.type}`,
        `Link: ${issueUrl(ref)}`,
        "",
        `## Children (${count}${omitted === null ? "" : ", incomplete"})`,
        ...read.children.map(
          (child) =>
            `- ${ticketExternalId({ site, key: child.key })} — ${child.key} [${
              child.status
            }] ${child.summary}`,
        ),
        omitted === null ? null : "",
        omitted,
        "",
        read.epic.description,
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
    },
  };
}

export interface TransitionRead {
  readonly id: string;
  readonly name: string;
  readonly toStatus: string;
  readonly toCategory: string;
}

export function readTransitions(payload: unknown): readonly TransitionRead[] {
  const raw = record(payload);
  const entries = raw === null ? null : raw["transitions"];
  if (!Array.isArray(entries)) {
    return [];
  }
  const read: TransitionRead[] = [];
  for (const entry of entries) {
    const one = record(entry);
    if (one === null) {
      continue;
    }
    const id = text(one["id"]);
    if (id === "") {
      continue;
    }
    const to = record(one["to"]);
    read.push({
      id,
      name: text(one["name"]),
      toStatus: to === null ? "" : text(to["name"]),
      toCategory:
        to === null ? "" : text(record(to["statusCategory"])?.["key"]),
    });
  }
  return read;
}

/**
 * An issue's status and the transitions available from it, as a **document** (§3.1: "a
 * durable piece of prose").
 *
 * This exists because §9.4 asks for "statuses and transitions" and a transition is not
 * a concept — it is a fact about one issue's workflow that a session needs *before* it
 * asks for a move, and that only Jira can answer: which moves exist depends on the
 * project's workflow and on the caller's own permissions.
 */
export function workflowObject(
  site: string,
  issue: IssueRead,
  transitions: readonly TransitionRead[],
): ProducedObject {
  const ref: IssueRef = { site, key: issue.key };
  const title = `${issue.key} workflow`;
  const available =
    transitions.length === 0
      ? ["(Jira offers this account no transition from here)"]
      : transitions.map(
          (transition) =>
            `- ${transition.name} (id ${transition.id}) → ${transition.toStatus}`,
        );
  return {
    kind: "document",
    externalId: workflowExternalId(ref),
    title,
    renderings: {
      card: `${issue.key} — ${issue.status}, ${transitions.length} transition${
        transitions.length === 1 ? "" : "s"
      }`,
      summary: `${issue.key} is in ${issue.status}; available: ${
        transitions.length === 0
          ? "nothing"
          : transitions.map((one) => one.toStatus).join(", ")
      }`,
      agentContent: [
        `# ${title}`,
        "",
        `Current status: ${issue.status} (category ${issue.statusCategory})`,
        `Link: ${issueUrl(ref)}`,
        "",
        "## Transitions available now",
        ...available,
        "",
        "A transition is asked for by id; Jira decides what actually happens, so the",
        "result is read back rather than assumed (§9.2).",
      ].join("\n"),
    },
  };
}

/**
 * Jira's search answer: the issues, and whether there are more than were read.
 *
 * `nextPageToken` is the modern JQL search's own way of saying "there is more"; a
 * `total` is used when the payload carries one. Either way the caller is told, because
 * a page silently standing in for a query is the wrong answer with no evidence
 * (principle 12).
 */
export interface SearchRead {
  readonly issues: readonly IssueRead[];
  readonly more: boolean;
  readonly total: number | null;
}

export function readSearch(payload: unknown): SearchRead {
  const raw = record(payload);
  const issues = raw === null ? null : raw["issues"];
  const read = Array.isArray(issues)
    ? issues
        .map(readIssue)
        .filter((issue): issue is IssueRead => issue !== null)
    : [];
  const total =
    raw !== null && typeof raw["total"] === "number" ? raw["total"] : null;
  const hasToken =
    raw !== null &&
    typeof raw["nextPageToken"] === "string" &&
    raw["nextPageToken"] !== "";
  return {
    issues: read,
    more: hasToken || (total !== null && total > read.length),
    total,
  };
}
