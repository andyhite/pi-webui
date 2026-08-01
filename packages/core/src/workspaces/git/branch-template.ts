/**
 * Branch naming (§3.4).
 *
 * "For git: a branch, named from a configurable template (ticket, project,
 * repository, title slug). An existing branch is never renamed or re-derived."
 *
 * The template is the configurable part; `resolveBranchName` is the rule that
 * an existing branch wins over it, expressed as a function rather than as
 * discipline at the provisioning call site.
 */

export const BRANCH_TEMPLATE_TOKENS = [
  "type",
  "ticket",
  "project",
  "repository",
  "title",
] as const;

export type BranchTemplateToken = (typeof BRANCH_TEMPLATE_TOKENS)[number];

export type BranchTemplateInputs = {
  readonly [K in BranchTemplateToken]?: string | null;
};

/** Matches this repository's own convention: `<type>/<ticket>-<slug>`. */
export const DEFAULT_BRANCH_TEMPLATE = "{type}/{ticket}-{title}";

/** Long titles make unusable branch names; the cap is stated, not silent. */
export const DEFAULT_MAX_SEGMENT_LENGTH = 48;

export interface BranchTemplateOptions {
  readonly maxSegmentLength?: number;
}

export type BranchNameRefusalReason =
  "unknown_token" | "empty_result" | "invalid_ref_name";

export interface BranchNameRefusal {
  readonly reason: BranchNameRefusalReason;
  readonly message: string;
}

export type BranchNameResult =
  | {
      readonly named: true;
      readonly branch: string;
      /** True when a value was shortened to fit; reported rather than assumed. */
      readonly shortened: boolean;
    }
  | { readonly named: false; readonly refusal: BranchNameRefusal };

const TOKEN = /\{([a-zA-Z]+)\}/gu;
const SEPARATOR_RUN = /[/-]{2,}/gu;

export function slugify(value: string, maxLength: number): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (slug.length <= maxLength) return slug;
  return slug.slice(0, maxLength).replace(/-+$/u, "");
}

export function renderBranchTemplate(
  template: string,
  inputs: BranchTemplateInputs,
  options: BranchTemplateOptions = {},
): BranchNameResult {
  const maxLength = options.maxSegmentLength ?? DEFAULT_MAX_SEGMENT_LENGTH;
  let shortened = false;
  let unknownToken: string | null = null;

  const rendered = template.replace(TOKEN, (_match, rawToken: string) => {
    const token = rawToken as BranchTemplateToken;
    if (!(BRANCH_TEMPLATE_TOKENS as readonly string[]).includes(token)) {
      unknownToken = rawToken;
      return "";
    }
    const value = inputs[token];
    if (value === undefined || value === null || value.trim() === "") return "";
    const slug = slugify(value, maxLength);
    if (slugify(value, Number.MAX_SAFE_INTEGER).length > slug.length) {
      shortened = true;
    }
    return slug;
  });

  if (unknownToken !== null) {
    return {
      named: false,
      refusal: {
        reason: "unknown_token",
        message: `Branch template uses {${unknownToken}}, which is not one of ${BRANCH_TEMPLATE_TOKENS.map((token) => `{${token}}`).join(", ")}.`,
      },
    };
  }

  const collapsed = rendered
    .replace(SEPARATOR_RUN, (run) => (run.includes("/") ? "/" : "-"))
    .replace(/^[/-]+|[/-]+$/gu, "");

  if (collapsed === "") {
    return {
      named: false,
      refusal: {
        reason: "empty_result",
        message: `Branch template "${template}" produced an empty name from the values available.`,
      },
    };
  }

  const validity = checkRefName(collapsed);
  if (!validity.valid) {
    return { named: false, refusal: validity.refusal };
  }

  return { named: true, branch: collapsed, shortened };
}

export type RefNameCheck =
  | { readonly valid: true }
  | { readonly valid: false; readonly refusal: BranchNameRefusal };

// Control characters are exactly what git refuses in a ref name, so the rule
// has to name them.
// eslint-disable-next-line no-control-regex
const ILLEGAL_REF_CHARACTERS = /[\s~^:?*[\\\u0000-\u001f\u007f]/u;

/** git's own rules, applied before git is asked, so the refusal is legible. */
export function checkRefName(name: string): RefNameCheck {
  const problems: string[] = [];
  if (ILLEGAL_REF_CHARACTERS.test(name))
    problems.push("illegal characters for a git ref");
  if (name.includes("..")) problems.push("`..`");
  if (name.includes("@{")) problems.push("`@{`");
  if (name.startsWith("/") || name.endsWith("/"))
    problems.push("a leading or trailing `/`");
  if (name.endsWith(".") || name.endsWith(".lock"))
    problems.push("a trailing `.` or `.lock`");
  if (name === "@") problems.push("the reserved name `@`");
  if (name.split("/").some((segment) => segment.startsWith(".")))
    problems.push("a path segment starting with `.`");

  if (problems.length === 0) return { valid: true };
  return {
    valid: false,
    refusal: {
      reason: "invalid_ref_name",
      message: `"${name}" is not a valid git branch name: it contains ${problems.join(", ")}.`,
    },
  };
}

export type ResolvedBranchName =
  | {
      readonly named: true;
      readonly branch: string;
      /**
       * False when the branch already existed and was taken as it is. An
       * existing branch is never renamed or re-derived (§3.4).
       */
      readonly derived: boolean;
      readonly shortened: boolean;
    }
  | { readonly named: false; readonly refusal: BranchNameRefusal };

/**
 * The branch a workspace will use. If the workstream already has one — because
 * it was provisioned before, or because the human named the branch — that one
 * is returned untouched, template or no template.
 */
export function resolveBranchName(
  existingBranch: string | null,
  template: string,
  inputs: BranchTemplateInputs,
  options: BranchTemplateOptions = {},
): ResolvedBranchName {
  if (existingBranch !== null && existingBranch.trim() !== "") {
    const validity = checkRefName(existingBranch);
    if (!validity.valid) return { named: false, refusal: validity.refusal };
    return {
      named: true,
      branch: existingBranch,
      derived: false,
      shortened: false,
    };
  }

  const result = renderBranchTemplate(template, inputs, options);
  if (!result.named) return result;
  return {
    named: true,
    branch: result.branch,
    derived: true,
    shortened: result.shortened,
  };
}
