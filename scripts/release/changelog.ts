/**
 * `CHANGELOG.md` maintenance (decision 0003 §4, #94). The file is generated
 * from the range and never hand-edited, so this only ever *adds* a section
 * and never rewrites one that already exists — a released section is a
 * record of what landed, and rewriting it would be the drift the decision
 * exists to prevent.
 */

/** The placeholder the file carries until the first tag replaces it. */
const UNRELEASED_HEADING = "## Unreleased";

export interface ChangelogSection {
  /** `0.1.0`, without the `v` — the heading adds it. */
  readonly version: string;
  /** `YYYY-MM-DD`, the release's own date. */
  readonly date: string;
  /** {@link renderNotes}'s output. */
  readonly notes: string;
}

export function renderSection(section: ChangelogSection): string {
  return `## v${section.version} — ${section.date}\n\n${section.notes}\n`;
}

/**
 * The file with `section` inserted as the newest release.
 *
 * The prose above the first heading is the file's own explanation of itself
 * and is preserved verbatim. The `## Unreleased` placeholder is *replaced*
 * on the first release, exactly as it says it will be; after that the new
 * section goes above the previous newest one and nothing below is touched.
 */
export function withSection(
  existing: string,
  section: ChangelogSection,
): string {
  const firstHeading = existing.search(/^## /m);
  const preamble =
    firstHeading === -1 ? existing : existing.slice(0, firstHeading);
  const sections = firstHeading === -1 ? "" : existing.slice(firstHeading);

  const kept = sections.startsWith(UNRELEASED_HEADING)
    ? dropFirstSection(sections)
    : sections;

  const rendered = renderSection(section);
  const tail = kept.trim() === "" ? "" : `\n${kept.trimStart()}`;
  return `${preamble.trimEnd()}\n\n${rendered}${tail}`;
}

/** Everything after the first section, i.e. from the second `## ` heading on. */
function dropFirstSection(sections: string): string {
  const next = sections.slice(UNRELEASED_HEADING.length).search(/^## /m);
  if (next === -1) return "";
  return sections.slice(UNRELEASED_HEADING.length + next);
}

/**
 * Whether this version already has a section. The script refuses rather than
 * writing a second one: two sections for one version is a changelog that
 * disagrees with itself, and it means the previous run half-completed.
 */
export function hasSection(existing: string, version: string): boolean {
  return new RegExp(`^## v${version.replace(/\./g, "\\.")}\\b`, "m").test(
    existing,
  );
}
