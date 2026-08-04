/**
 * Release notes, generated from the range (decision 0003 §4, #94): grouped
 * by type then scope, and never hand-written, so they cannot drift from what
 * landed.
 *
 * Every commit in the range appears exactly once. In particular a breaking
 * change gets **no section of its own** — it is marked in place, under its
 * own type, because a "Breaking changes" section that repeated the entry
 * would break the one property these notes are supposed to have.
 */
import type { ParsedCommit } from "./commits.ts";

/**
 * Heading per type, in the order sections are emitted. What a reader cares
 * about first comes first; the tail is the record rather than the news.
 * Keys match {@link BUMP_BY_TYPE}'s, so a type with a bump rule and no
 * heading is a gap {@link headinglessTypes} reports.
 */
const HEADING_BY_TYPE: Record<string, string> = {
  feat: "Features",
  fix: "Fixes",
  perf: "Performance",
  revert: "Reverts",
  refactor: "Refactoring",
  docs: "Documentation",
  test: "Tests",
  build: "Build",
  ci: "CI",
  chore: "Chores",
  style: "Style",
};

const TYPE_ORDER: readonly string[] = Object.keys(HEADING_BY_TYPE);

/** Types with no heading — the same "stated, not hoped for" check as the bump table. */
export function headinglessTypes(
  commits: readonly ParsedCommit[],
): readonly string[] {
  const missing = new Set<string>();
  for (const commit of commits) {
    if (HEADING_BY_TYPE[commit.type] === undefined) missing.add(commit.type);
  }
  return [...missing].sort();
}

/**
 * `- **scope:** description (hash)`, with breaking changes marked.
 *
 * The short hash is in the line because the notes are the changelog and the
 * changelog is this repository's only record of completed work
 * (`AGENTS.md` → "Documentation"): a reader who wants the diff should not
 * have to search for it by prose.
 */
function renderEntry(commit: ParsedCommit): string {
  const mark = commit.breaking ? "**BREAKING** " : "";
  const scope = commit.scope === undefined ? "" : `**${commit.scope}:** `;
  return `- ${mark}${scope}${commit.description} (${commit.hash.slice(0, 8)})`;
}

/**
 * Within a type, entries are ordered by scope and then by description, so
 * everything touching one area reads together — the "then scope" half of
 * 0003 §4. Scope-less commits sort first: they are the ones that are about
 * the product rather than a corner of it.
 *
 * Plain codepoint comparison rather than `localeCompare`, whose default
 * collation is the *host's*. A section is generated once and never rewritten,
 * so if the machine cutting a release could change the order, "generated from
 * the range" would stop meaning the range determines the bytes — and the drift
 * would be silent, since nothing ever re-renders an old section to disagree
 * with it.
 */
function byScopeThenDescription(a: ParsedCommit, b: ParsedCommit): number {
  const scopeA = a.scope ?? "";
  const scopeB = b.scope ?? "";
  if (scopeA !== scopeB) return scopeA < scopeB ? -1 : 1;
  if (a.description === b.description) return 0;
  return a.description < b.description ? -1 : 1;
}

/** The body of one release's section: headings and bullets, no title. */
export function renderNotes(commits: readonly ParsedCommit[]): string {
  const sections: string[] = [];
  for (const type of TYPE_ORDER) {
    const inType = commits
      .filter((commit) => commit.type === type)
      .sort(byScopeThenDescription);
    if (inType.length === 0) continue;
    const heading = HEADING_BY_TYPE[type];
    sections.push(`### ${heading}\n\n${inType.map(renderEntry).join("\n")}`);
  }
  return sections.join("\n\n");
}
