/**
 * Conventional Commit parsing for the release script (decision 0003, #94).
 *
 * Deliberately not a general-purpose parser. `commitlint` already gates the
 * range before any of this runs, so this reads messages that have been
 * accepted and turns them into the shape the derivation needs. What it does
 * not do is guess: a subject it cannot parse is returned as `undefined` so
 * the caller can name the commit and stop, rather than silently dropping a
 * commit out of the version derivation and the changelog at once.
 */

/** One commit as `git log` hands it over, before any interpretation. */
export interface CommitRecord {
  readonly hash: string;
  readonly subject: string;
  readonly body: string;
}

export interface ParsedCommit {
  readonly hash: string;
  /** The Conventional Commit type, lowercase (`feat`, `fix`, …). */
  readonly type: string;
  /** The optional scope, or `undefined` when the subject declared none. */
  readonly scope: string | undefined;
  /** `!` after the type/scope, or a `BREAKING CHANGE:` footer. */
  readonly breaking: boolean;
  readonly description: string;
}

/**
 * `type(scope)!: description`. The type and scope are constrained to what
 * commitlint's own conventional config accepts (lowercase, no spaces), so a
 * subject like `Revert "feat: x"` — which commitlint rejects — does not
 * accidentally parse as a type of `Revert "feat`.
 */
const SUBJECT =
  /^(?<type>[a-z]+)(?:\((?<scope>[^()\s]+)\))?(?<bang>!)?: (?<description>.+)$/;

/**
 * A `BREAKING CHANGE:` (or `BREAKING-CHANGE:`) **footer**, which the
 * specification places in the trailing block after the last blank line.
 * `AGENTS.md` asks for the spaced spelling; the hyphenated one is accepted
 * because the specification treats them as equivalent and refusing it would
 * make an otherwise-correct message silently non-breaking.
 *
 * Scoped to that trailing block rather than matched line-initially anywhere,
 * so a body that *quotes* an earlier commit's footer on its own line — easy in
 * a `revert:`, or a `fix:` citing what it undoes — does not declare a breaking
 * change on its behalf. At `0.x` that would be invisible (breaking and `feat`
 * are both minor); from `1.0.0` it is a spurious major.
 */
function declaresBreaking(body: string): boolean {
  const trailing =
    body
      .trimEnd()
      .split(/\n[ \t]*\n/)
      .at(-1) ?? "";
  return /^BREAKING[ -]CHANGE:/m.test(trailing);
}

export function parseCommit(record: CommitRecord): ParsedCommit | undefined {
  const match = SUBJECT.exec(record.subject);
  const groups = match?.groups;
  if (groups?.["type"] === undefined || groups["description"] === undefined) {
    return undefined;
  }
  return {
    hash: record.hash,
    type: groups["type"],
    scope: groups["scope"],
    breaking: groups["bang"] !== undefined || declaresBreaking(record.body),
    description: groups["description"],
  };
}

/**
 * Every record, or the first one that does not parse. Not a filter: a
 * commit the parser cannot read means it and commitlint disagree about the
 * same message, and continuing would drop it from both the version
 * derivation and the changelog without saying so.
 */
export function parseCommits(
  records: readonly CommitRecord[],
):
  | { readonly commits: readonly ParsedCommit[] }
  | { readonly unparsed: CommitRecord } {
  const commits: ParsedCommit[] = [];
  for (const record of records) {
    const parsed = parseCommit(record);
    if (parsed === undefined) return { unparsed: record };
    commits.push(parsed);
  }
  return { commits };
}
