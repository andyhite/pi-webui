import { describe, expect, it } from "vitest";

import { newSetupAttemptId } from "./ids.js";
import {
  checkReady,
  initialReadiness,
  readinessProvisionFailed,
  readinessProvisioned,
  readinessProvisioning,
  readinessSetupFinished,
  readinessSetupStarted,
  resolveSetup,
  type SetupAttempt,
  type SetupDeclaration,
} from "./readiness.js";

const NOW = 1_700_000_000_000;

const repoDeclaration: SetupDeclaration = {
  program: "pnpm",
  args: ["install", "--frozen-lockfile"],
  workingSubdirectory: "",
  label: "pnpm install",
};

const overrideDeclaration: SetupDeclaration = {
  program: "make",
  args: ["bootstrap"],
  workingSubdirectory: "",
  label: "make bootstrap",
};

function attempt(overrides: Partial<SetupAttempt> = {}): SetupAttempt {
  return {
    id: newSetupAttemptId(),
    setup: {
      ...repoDeclaration,
      source: "repository",
      overridesRepository: false,
    },
    startedAt: NOW,
    finishedAt: NOW + 1000,
    outcome: "succeeded",
    exitCode: 0,
    stdout: "done",
    stderr: "",
    failure: null,
    ...overrides,
  };
}

describe("resolveSetup", () => {
  it("prefers the repository declaration — it travels with the code (§3.4)", () => {
    expect(resolveSetup(repoDeclaration, null)).toMatchObject({
      program: "pnpm",
      source: "repository",
      overridesRepository: false,
    });
  });

  it("lets the settings override win and says that it did", () => {
    expect(resolveSetup(repoDeclaration, overrideDeclaration)).toMatchObject({
      program: "make",
      source: "settings-override",
      overridesRepository: true,
    });
  });

  it("returns null when nothing declares a setup step", () => {
    expect(resolveSetup(null, null)).toBeNull();
  });
});

describe("readiness gate", () => {
  it("blocks an unprovisioned workspace with a visible reason", () => {
    const check = checkReady(initialReadiness(NOW));

    expect(check.ready).toBe(false);
    if (check.ready) return;
    expect(check.refusal.reason).toBe("unprovisioned");
    expect(check.refusal.message).not.toBe("");
  });

  it("blocks while provisioning", () => {
    const record = readinessProvisioning(initialReadiness(NOW), NOW);

    expect(checkReady(record).ready).toBe(false);
  });

  it("is ready immediately when the repository declares no setup step", () => {
    const record = readinessProvisioned(initialReadiness(NOW), null, NOW);

    expect(record.state).toBe("ready");
    expect(checkReady(record)).toEqual({ ready: true });
  });

  it("blocks a provisioned workspace whose declared setup has not run", () => {
    const setup = resolveSetup(repoDeclaration, null);
    const record = readinessProvisioned(initialReadiness(NOW), setup, NOW);

    const check = checkReady(record);

    expect(record.state).toBe("setup-required");
    expect(check.ready).toBe(false);
    if (check.ready) return;
    expect(check.refusal.reason).toBe("setup-required");
    expect(check.refusal.message).toContain("pnpm install");
  });

  it("blocks while setup is running, and points at the attempt", () => {
    const setup = resolveSetup(repoDeclaration, null);
    const running = attempt({
      outcome: "running",
      finishedAt: null,
      exitCode: null,
    });
    const record = readinessSetupStarted(
      readinessProvisioned(initialReadiness(NOW), setup, NOW),
      running,
      NOW,
    );

    const check = checkReady(record);

    expect(check.ready).toBe(false);
    if (check.ready) return;
    expect(check.refusal.reason).toBe("setup-running");
    expect(check.refusal.attemptId).toBe(running.id);
  });

  it("reports a failed setup rather than letting work run in it (§3.4)", () => {
    const setup = resolveSetup(repoDeclaration, null);
    const failed = attempt({
      outcome: "failed",
      exitCode: 1,
      stdout: "resolving",
      stderr: "ERR_PNPM_OUTDATED_LOCKFILE",
    });
    const record = readinessSetupFinished(
      readinessProvisioned(initialReadiness(NOW), setup, NOW),
      failed,
      NOW,
    );

    const check = checkReady(record);

    expect(record.state).toBe("setup-failed");
    expect(check.ready).toBe(false);
    if (check.ready) return;
    expect(check.refusal.reason).toBe("setup-failed");
    expect(check.refusal.message).toContain("exit code 1");
    expect(check.refusal.attemptId).toBe(failed.id);
    expect(record.lastAttempt?.stderr).toBe("ERR_PNPM_OUTDATED_LOCKFILE");
  });

  it("keeps the whole setup output, both streams, after success (§3.4, principle 12)", () => {
    const setup = resolveSetup(repoDeclaration, null);
    const long = "line\n".repeat(5000);
    const succeeded = attempt({ stdout: long, stderr: "warning: slow" });
    const record = readinessSetupFinished(
      readinessProvisioned(initialReadiness(NOW), setup, NOW),
      succeeded,
      NOW,
    );

    expect(record.state).toBe("ready");
    expect(checkReady(record)).toEqual({ ready: true });
    expect(record.lastAttempt?.stdout).toHaveLength(long.length);
    expect(record.lastAttempt?.stderr).toBe("warning: slow");
  });

  it("blocks with the mechanism's own reason when provisioning failed", () => {
    const record = readinessProvisionFailed(
      initialReadiness(NOW),
      "Permission denied (publickey).",
      NOW,
    );

    const check = checkReady(record);

    expect(check.ready).toBe(false);
    if (check.ready) return;
    expect(check.refusal.reason).toBe("provision-failed");
    expect(check.refusal.message).toContain("Permission denied (publickey).");
  });
});
