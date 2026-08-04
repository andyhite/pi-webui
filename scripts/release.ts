/**
 * The release script (decision 0003, #94). Run it through pnpm:
 *
 *   pnpm release --dry-run     # print the version and notes, write nothing
 *   pnpm release               # bump, generate, commit, tag
 *
 * It derives the version rather than taking one, because a number somebody
 * typed is a number that can disagree with what landed (0003 §3). The whole
 * derivation lives in `scripts/release/` and is unit-tested; this file is the
 * part that talks to git and the filesystem.
 *
 * **Why it commits.** #94 asks for the annotated tag. A tag on a commit that
 * does not contain the version it names is a tag that lies about itself, and
 * a script that refuses to *start* on a dirty tree should not *finish* by
 * leaving one. So the bump and the changelog land as one
 * `chore(release): vX.Y.Z` commit and the tag names it. `chore` bumps
 * nothing (0003 §3), so the commit cannot perturb the next range's
 * derivation. Pushing stays the operator's: the script prints the command
 * and does not run it, because publishing is not a repository convention
 * (0003's closing note) and #98 has not answered where anything is published
 * to.
 *
 * `ALLOW_MAIN_COMMIT` is set for that one commit. The husky guard exists so
 * nobody develops on `main` (`AGENTS.md`); a release commit on `main` is the
 * case the override is for, and it is scoped to this one `git commit` rather
 * than exported for the process.
 *
 * Node runs this file directly — 22.x strips the types — so there is no build
 * step between reading it and running it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseCommits, type CommitRecord } from "./release/commits.ts";
import { hasSection, withSection } from "./release/changelog.ts";
import { headinglessTypes, renderNotes } from "./release/notes.ts";
import {
  ZERO_VERSION,
  deriveRelease,
  formatVersion,
  parseVersion,
  unclassifiedTypes,
} from "./release/version.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST = fileURLToPath(new URL("../package.json", import.meta.url));
const CHANGELOG = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));

/** `git`, from the repository root, with its output as a trimmed string. */
function git(...args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function fail(message: string): never {
  console.error(`release: ${message}`);
  process.exit(1);
}

/**
 * The newest `vX.Y.Z` tag reachable from HEAD, or `undefined` on a repository
 * that has never released. Ordered by version rather than by tag date, so a
 * tag created out of order cannot make an older release look like the base.
 */
function previousTag(): string | undefined {
  const tags = git(
    "tag",
    "--list",
    "v*",
    "--merged",
    "HEAD",
    "--sort=-v:refname",
  )
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => parseVersion(line) !== undefined);
  return tags[0];
}

function commitRecords(range: string | undefined): readonly CommitRecord[] {
  // Unit separator between fields and record separator between commits: a
  // subject or body can contain any newline or tab it likes, and splitting on
  // those would silently truncate a message.
  const format = "%H%x1f%s%x1f%b%x1e";
  const log =
    range === undefined
      ? git("log", `--format=${format}`)
      : git("log", `--format=${format}`, range);
  return log
    .split("\x1e")
    .map((record) => record.trim())
    .filter((record) => record !== "")
    .map((record) => {
      // The tail is rejoined rather than dropped: git accepts any byte but
      // NUL in a message, so a body containing a literal `\x1f` would
      // otherwise be truncated at it — and a truncated body is a
      // `BREAKING CHANGE:` footer that silently stops counting.
      const [hash = "", subject = "", ...rest] = record.split("\x1f");
      return { hash, subject, body: rest.join("\x1f") };
    });
}

/**
 * commitlint on a range (or on one message via stdin), returning its output
 * when it *rejects* a commit.
 *
 * Exit status 1 is commitlint saying it found problems. Anything else is
 * commitlint itself failing — a missing `pnpm`, a config that throws — which
 * must not be reported as "your history is bad": that would send somebody to
 * rewrite commits over a broken toolchain.
 */
function commitlint(
  args: readonly string[],
  input?: string,
): string | undefined {
  try {
    execFileSync("pnpm", ["commitlint", ...args], {
      cwd: REPO_ROOT,
      stdio: "pipe",
      ...(input === undefined ? {} : { input }),
    });
    return undefined;
  } catch (error) {
    const result = error as {
      status?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    const output =
      `${String(result.stdout ?? "")}${String(result.stderr ?? "")}`.trim();
    if (result.status !== 1) {
      fail(
        `could not run commitlint (exit ${String(result.status)}):\n${output}`,
      );
    }
    return output;
  }
}

/**
 * Refusals from 0003's "Consequences": the derivation is only as trustworthy
 * as the messages, so a run that cannot trust its inputs must not produce a
 * version. A dry run performs all of them too — its job is to be reviewable,
 * and a dry run that skipped the checks would report a release the real run
 * would refuse.
 */
function refuseUnlessReleasable(previous: string | undefined): void {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") {
    fail(`releases are cut from main; this is ${branch}`);
  }
  if (git("status", "--porcelain") !== "") {
    fail(
      "the working tree is dirty; commit or stash before releasing so the tag names exactly what was verified",
    );
  }

  // The manifest must already say what the last tag says. Nothing else on
  // disk records that the previous release finished: if `git tag` failed
  // after the release commit landed, the tree is clean, the manifest and the
  // changelog describe a version no tag names, and the next run would derive
  // a *different* version — whose section would repeat every entry the
  // untagged one already listed, which is exactly the duplicate listing the
  // notes are built to make impossible. It also catches a hand-edited
  // manifest, and a `1.0.0` typed in by somebody rather than decided
  // (0003 §6).
  const declared = readFileSync(MANIFEST, "utf8").match(
    /^\s*"version":\s*"([^"]*)"/m,
  )?.[1];
  const expected =
    previous === undefined ? "0.0.0" : previous.replace(/^v/, "");
  if (declared !== expected) {
    fail(
      `the root manifest says ${String(declared)} but the newest tag says ${expected}; a release did not finish, or the version was edited by hand — reconcile the two before deriving another`,
    );
  }

  // The real linter, not a second implementation of it: what commitlint
  // accepts is what `AGENTS.md` and the commit-msg hook enforce, and a
  // reimplementation here could disagree with both.
  //
  // `--from` is exclusive, so on a repository with no tag yet the root
  // commits are outside every range that reaches them and have to be linted
  // on their own — otherwise the very first release is the one release whose
  // first commit nothing checked.
  const roots = git("rev-list", "--max-parents=0", "HEAD").split("\n");
  const from = previous ?? roots[0] ?? "HEAD";
  const rangeFailure = commitlint(["--from", from, "--to", "HEAD"]);
  if (rangeFailure !== undefined) {
    fail(
      `commitlint rejected a commit in ${from}..HEAD, so the derivation cannot be trusted:\n${rangeFailure}`,
    );
  }
  if (previous === undefined) {
    for (const root of roots) {
      const message = git("log", "-1", "--format=%B", root);
      const rootFailure = commitlint([], message);
      if (rootFailure !== undefined) {
        fail(
          `commitlint rejected the root commit ${root.slice(0, 8)}, so the derivation cannot be trusted:\n${rootFailure}`,
        );
      }
    }
  }
}

function main(): void {
  // Every unrecognised argument is refused rather than ignored. A mistyped
  // `--dry-run` would otherwise take the *write* path — commit and tag on
  // `main` — which is both the opposite of what was asked for and the
  // hardest outcome here to undo.
  const args = process.argv.slice(2);
  const unknown = args.filter((argument) => argument !== "--dry-run");
  if (unknown.length > 0) {
    fail(
      `unrecognised argument(s) ${unknown.join(", ")}; the only flag is --dry-run, and guessing at one would mean releasing when somebody meant not to`,
    );
  }
  const dryRun = args.includes("--dry-run");

  const tag = previousTag();
  const range = tag === undefined ? undefined : `${tag}..HEAD`;
  refuseUnlessReleasable(tag);

  const records = commitRecords(range);
  if (records.length === 0) {
    console.log(
      `release: nothing since ${tag ?? "the first commit"} — no release.`,
    );
    return;
  }

  const parsed = parseCommits(records);
  if ("unparsed" in parsed) {
    fail(
      `could not read a Conventional Commit out of ${parsed.unparsed.hash.slice(0, 8)} (${parsed.unparsed.subject}); commitlint and this script disagree about it, which must be fixed rather than worked around`,
    );
  }
  const { commits } = parsed;

  const unclassified = unclassifiedTypes(commits);
  if (unclassified.length > 0) {
    fail(
      `no bump rule for commit type(s) ${unclassified.join(", ")} — add them to BUMP_BY_TYPE (scripts/release/version.ts) rather than letting them bump nothing by accident`,
    );
  }
  const headingless = headinglessTypes(commits);
  if (headingless.length > 0) {
    fail(
      `no changelog heading for commit type(s) ${headingless.join(", ")} — add them to HEADING_BY_TYPE (scripts/release/notes.ts); a commit with no heading would be dropped from the notes`,
    );
  }

  const previous =
    tag === undefined ? ZERO_VERSION : (parseVersion(tag) ?? ZERO_VERSION);
  const release = deriveRelease(previous, commits);
  if (release === undefined) {
    console.log(
      `release: ${commits.length} commit(s) since ${tag ?? "the first commit"}, none of a type that bumps a version — no release (decision 0003 §3).`,
    );
    return;
  }

  const version = formatVersion(release.version);
  const notes = renderNotes(commits);
  const date = new Date().toISOString().slice(0, 10);

  // Echoed as its own subject, scope and `!` included, so the line can be
  // matched against `git log` rather than merely resembling it.
  const earned = release.reason[0];
  const earnedSubject =
    earned === undefined
      ? "none"
      : `${earned.hash.slice(0, 8)} ${earned.type}${earned.scope === undefined ? "" : `(${earned.scope})`}${earned.breaking ? "!" : ""}: ${earned.description}`;
  console.log(
    `release: v${version} (${release.bump} from v${formatVersion(previous)})`,
  );
  console.log(
    `  earned by ${release.reason.length} commit(s), e.g. ${earnedSubject}`,
  );
  console.log(`  ${commits.length} commit(s) in the notes\n`);
  console.log(notes);

  if (dryRun) {
    console.log(
      `\nrelease: --dry-run, so nothing was written, committed or tagged.`,
    );
    return;
  }

  const changelog = readFileSync(CHANGELOG, "utf8");
  if (hasSection(changelog, version)) {
    fail(
      `CHANGELOG.md already has a v${version} section; a previous run half-completed and the state needs looking at rather than a second section`,
    );
  }

  const manifest = readFileSync(MANIFEST, "utf8");
  // Textual, one field: `JSON.parse`/`stringify` would reformat the whole
  // manifest and fight `prettier` over it.
  const bumped = manifest.replace(
    /^(\s*"version":\s*)"[^"]*"/m,
    `$1"${version}"`,
  );
  if (bumped === manifest) {
    fail(`could not find a "version" field to bump in ${MANIFEST}`);
  }

  writeFileSync(MANIFEST, bumped, "utf8");
  writeFileSync(
    CHANGELOG,
    withSection(changelog, { version, date, notes }),
    "utf8",
  );

  // Formatted before it is staged, because the pre-commit hook runs
  // `format:check` over the whole tree: a subject prettier would re-print
  // (emphasis markers, doubled spaces — commitlint permits both) would
  // otherwise make the hook reject the release commit *after* both files had
  // already been rewritten. Generated content is exactly the content that
  // should not be asking a human to reformat it.
  execFileSync(
    "pnpm",
    ["exec", "prettier", "--write", "CHANGELOG.md", "package.json"],
    {
      cwd: REPO_ROOT,
      stdio: "pipe",
    },
  );

  // From here the tree is already rewritten, so a failure has to say what
  // state it left rather than throw a stack trace: the next run would meet
  // the dirty-tree refusal, whose "commit or stash" advice is the wrong
  // advice for a half-written release.
  try {
    git("add", "package.json", "CHANGELOG.md");
    execFileSync("git", ["commit", "-m", `chore(release): v${version}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      // Scoped to this commit: the guard is there so nobody *develops* on main
      // (`AGENTS.md`), and this is the one commit it is meant to allow.
      env: { ...process.env, ALLOW_MAIN_COMMIT: "1" },
    });
    git("tag", "-a", `v${version}`, "-m", `v${version}\n\n${notes}`);
  } catch (error) {
    const streams = error as { stdout?: unknown; stderr?: unknown };
    fail(
      `v${version} was written to package.json and CHANGELOG.md but git refused to record it:\n${`${String(streams.stdout ?? "")}${String(streams.stderr ?? "")}`.trim()}\n\nNothing was pushed. To get back to where this started:\n  git reset HEAD -- package.json CHANGELOG.md && git checkout -- package.json CHANGELOG.md && git tag -d v${version} 2>/dev/null`,
    );
  }

  console.log(
    `\nrelease: committed and tagged v${version}. Push it when you mean to:\n  git push origin main && git push origin v${version}`,
  );
}

main();
