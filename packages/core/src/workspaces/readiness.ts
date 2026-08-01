import type { EpochMillis } from "./exec.js";
import type { SetupAttemptId } from "./ids.js";

/**
 * Readiness, not just existence (§3.4).
 *
 * "A fresh checkout has no installed dependencies, so nothing can be verified
 * in it. A workspace has a **ready** state: a declared per-repository setup
 * step runs after creation and before anything may run there. Not-ready blocks
 * work with the reason visible; setup output is inspectable; a failed setup is
 * reported rather than silently producing failures downstream."
 *
 * The gate is a predicate here rather than a convention at the run path, so the
 * canvas, the API, and agent tools refuse identically (principle 8). Setup
 * output is kept whole: nothing in this module shortens it (principle 12).
 */

export const READINESS_STATES = [
  /** No mechanism exists yet — provisioning happens at first run (§3.4, §3.5). */
  "unprovisioned",
  "provisioning",
  /** Provisioned, with a declared setup step that has not succeeded yet. */
  "setup-required",
  "setup-running",
  "ready",
  /** The setup step ran and failed. Reported, never silently downstream. */
  "setup-failed",
  /** Provisioning itself failed; the reason is on the record. */
  "provision-failed",
] as const;

export type ReadinessState = (typeof READINESS_STATES)[number];

/** Where a setup declaration came from (§3.4). */
export const SETUP_SOURCES = [
  /** Travelling with the code, reviewable — the preferred home. */
  "repository",
  /** The override for repositories you cannot commit to. */
  "settings-override",
] as const;

export type SetupSource = (typeof SETUP_SOURCES)[number];

export interface SetupDeclaration {
  readonly program: string;
  readonly args: readonly string[];
  /** Relative to the workspace root; empty string means the root itself. */
  readonly workingSubdirectory: string;
  /** Human-facing name, shown when readiness blocks a run. */
  readonly label: string;
}

export interface ResolvedSetup extends SetupDeclaration {
  readonly source: SetupSource;
  /**
   * True when a repository declaration existed and the settings override won
   * anyway, so the operator can see which one is in force rather than guess.
   */
  readonly overridesRepository: boolean;
}

/**
 * The override wins where both exist, because it is the escape hatch for a
 * repository whose declaration is wrong and unfixable from here. Neither
 * present means there is nothing to run: a repository that needs no setup is
 * ready as soon as it is provisioned, not blocked forever on a step nobody
 * declared.
 */
export function resolveSetup(
  repository: SetupDeclaration | null,
  override: SetupDeclaration | null,
): ResolvedSetup | null {
  if (override !== null) {
    return {
      ...override,
      source: "settings-override",
      overridesRepository: repository !== null,
    };
  }
  if (repository !== null) {
    return { ...repository, source: "repository", overridesRepository: false };
  }
  return null;
}

export const SETUP_OUTCOMES = ["running", "succeeded", "failed"] as const;

export type SetupOutcome = (typeof SETUP_OUTCOMES)[number];

/**
 * One run of the declared setup step, kept whole so it is inspectable after the
 * fact (§3.4). `stdout` and `stderr` stay separate and complete — the product
 * never silently truncates (principle 12).
 */
export interface SetupAttempt {
  readonly id: SetupAttemptId;
  readonly setup: ResolvedSetup;
  readonly startedAt: EpochMillis;
  readonly finishedAt: EpochMillis | null;
  readonly outcome: SetupOutcome;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Why it failed when there is no exit code to explain it (the step could not start). */
  readonly failure: string | null;
}

/** The readiness half of the workspace record the server stores. */
export interface ReadinessRecord {
  readonly state: ReadinessState;
  readonly since: EpochMillis;
  /** Null when the repository declares no setup step. */
  readonly setup: ResolvedSetup | null;
  /** The most recent attempt, kept for its output even after success. */
  readonly lastAttempt: SetupAttempt | null;
  /** Set when provisioning failed; the honest reason, verbatim. */
  readonly provisionFailure: string | null;
}

export function initialReadiness(now: EpochMillis): ReadinessRecord {
  return {
    state: "unprovisioned",
    since: now,
    setup: null,
    lastAttempt: null,
    provisionFailure: null,
  };
}

/**
 * State transitions as pure reducers, so persistence (Track A, Phase 2) stores
 * what the domain decided rather than deciding it a second time.
 */
export function readinessProvisioning(
  record: ReadinessRecord,
  now: EpochMillis,
): ReadinessRecord {
  return { ...record, state: "provisioning", since: now };
}

export function readinessProvisioned(
  record: ReadinessRecord,
  setup: ResolvedSetup | null,
  now: EpochMillis,
): ReadinessRecord {
  return {
    ...record,
    state: setup === null ? "ready" : "setup-required",
    since: now,
    setup,
    provisionFailure: null,
  };
}

export function readinessProvisionFailed(
  record: ReadinessRecord,
  failure: string,
  now: EpochMillis,
): ReadinessRecord {
  return {
    ...record,
    state: "provision-failed",
    since: now,
    provisionFailure: failure,
  };
}

export function readinessSetupStarted(
  record: ReadinessRecord,
  attempt: SetupAttempt,
  now: EpochMillis,
): ReadinessRecord {
  return {
    ...record,
    state: "setup-running",
    since: now,
    setup: attempt.setup,
    lastAttempt: attempt,
  };
}

export function readinessSetupFinished(
  record: ReadinessRecord,
  attempt: SetupAttempt,
  now: EpochMillis,
): ReadinessRecord {
  return {
    ...record,
    state: attempt.outcome === "succeeded" ? "ready" : "setup-failed",
    since: now,
    setup: attempt.setup,
    lastAttempt: attempt,
  };
}

export type ReadinessRefusalReason =
  | "unprovisioned"
  | "provisioning"
  | "provision-failed"
  | "setup-required"
  | "setup-running"
  | "setup-failed";

export interface ReadinessRefusal {
  readonly reason: ReadinessRefusalReason;
  /** What the operator is shown; not-ready always blocks with a visible reason. */
  readonly message: string;
  /** The attempt whose output explains a failure, so it can be opened from the refusal. */
  readonly attemptId: SetupAttemptId | null;
}

export type ReadinessCheck =
  | { readonly ready: true }
  | { readonly ready: false; readonly refusal: ReadinessRefusal };

/**
 * The gate: nothing may run in a workspace that is not ready (§3.4). Called by
 * the run path before a session starts, and by any agent tool that would write
 * in a workspace.
 */
export function checkReady(record: ReadinessRecord): ReadinessCheck {
  if (record.state === "ready") return { ready: true };

  const attemptId = record.lastAttempt?.id ?? null;
  const label = record.setup?.label ?? "the declared setup step";

  switch (record.state) {
    case "unprovisioned":
      return refuse("unprovisioned", "Workspace is not provisioned yet.", null);
    case "provisioning":
      return refuse(
        "provisioning",
        "Workspace is still being provisioned.",
        null,
      );
    case "provision-failed":
      return refuse(
        "provision-failed",
        `Provisioning failed: ${record.provisionFailure ?? "no reason recorded"}`,
        null,
      );
    case "setup-required":
      return refuse(
        "setup-required",
        `Workspace is not ready: ${label} has not run yet.`,
        attemptId,
      );
    case "setup-running":
      return refuse(
        "setup-running",
        `Workspace is not ready: ${label} is running.`,
        attemptId,
      );
    case "setup-failed":
      return refuse(
        "setup-failed",
        `Workspace is not ready: ${label} failed${
          record.lastAttempt?.exitCode === null ||
          record.lastAttempt?.exitCode === undefined
            ? ""
            : ` with exit code ${record.lastAttempt.exitCode}`
        }. Its output is on the workspace.`,
        attemptId,
      );
  }
}

function refuse(
  reason: ReadinessRefusalReason,
  message: string,
  attemptId: SetupAttemptId | null,
): ReadinessCheck {
  return { ready: false, refusal: { reason, message, attemptId } };
}
