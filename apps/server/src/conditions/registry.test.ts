import { expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "bun:test";
import {
  humanAuthor,
  newWorkspaceRecord,
  newWorkspaceId,
  type CommandExec,
  type Workspace,
  type WorldCondition,
} from "@plotroom/core";
import {
  ConditionCheckRegistry,
  createConditionChecks,
  workspaceCommandSucceeds,
} from "./registry.js";

let dir: string;
let workspace: Workspace;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plotroom-conditions-"));
  workspace = {
    ...newWorkspaceRecord(
      {
        id: newWorkspaceId(),
        workstreamId: "ws_1" as never,
        kind: "git",
        config: {},
        createdBy: humanAuthor,
      },
      0,
    ),
    roots: [{ key: "root", path: dir, branch: "main", primaryCheckout: false }],
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function condition(overrides: Partial<WorldCondition> = {}): WorldCondition {
  return {
    id: "output_written",
    predicate: "workspace_file_exists",
    description: "the workspace contains out.txt",
    args: { path: "out.txt" },
    ...overrides,
  };
}

async function evaluate(
  registry: ConditionCheckRegistry,
  ...conditions: WorldCondition[]
) {
  return registry.evaluate(conditions, { workspace, workspacePath: dir });
}

const noExec: CommandExec = async () => ({
  exitCode: 0,
  stdout: "",
  stderr: "",
});

describe("world-condition checks (§3.5, principle 3)", () => {
  it("holds only when the file is really there", async () => {
    const registry = createConditionChecks(noExec);

    expect(await evaluate(registry, condition())).toEqual([
      {
        conditionId: "output_written",
        holds: false,
        detail: "out.txt does not exist in the workspace",
      },
    ]);

    writeFileSync(join(dir, "out.txt"), "done", "utf8");

    expect(await evaluate(registry, condition())).toEqual([
      { conditionId: "output_written", holds: true },
    ]);
  });

  it("says nobody checked rather than quietly passing (§3.5)", async () => {
    const registry = createConditionChecks(noExec);

    const [evaluation] = await evaluate(
      registry,
      condition({ id: "checks_green", predicate: "github_checks_green" }),
    );

    expect(evaluation?.holds).toBe(false);
    expect(evaluation?.detail).toMatch(/no checker is available/);
    expect(evaluation?.detail).toMatch(/which is not proof/);
  });

  it("refuses to look outside the workspace boundary (§3.4)", async () => {
    const registry = createConditionChecks(noExec);

    const [evaluation] = await evaluate(
      registry,
      condition({ args: { path: "../escape.txt" } }),
    );

    expect(evaluation?.holds).toBe(false);
    expect(evaluation?.detail).toMatch(/outside the workspace/);
  });

  it("reports a declaration that is missing its argument", async () => {
    const registry = createConditionChecks(noExec);

    const [evaluation] = await evaluate(registry, {
      id: "output_written",
      predicate: "workspace_file_exists",
      description: "something exists",
    });

    expect(evaluation?.holds).toBe(false);
    expect(evaluation?.detail).toMatch(/needs a path argument/);
  });

  it("hands a failing command's own output back as feedback", async () => {
    const registry = new ConditionCheckRegistry();
    registry.register(
      workspaceCommandSucceeds(async () => ({
        exitCode: 2,
        stdout: "",
        stderr: "3 tests failed\n",
      })),
    );

    const [evaluation] = await evaluate(
      registry,
      condition({
        id: "tests_pass",
        predicate: "workspace_command_succeeds",
        args: { program: "pnpm", args: "test" },
      }),
    );

    expect(evaluation?.holds).toBe(false);
    expect(evaluation?.detail).toBe("pnpm exited 2: 3 tests failed");
  });

  it("treats a checker that throws as proof of nothing", async () => {
    const registry = new ConditionCheckRegistry();
    registry.register({
      predicate: "explodes",
      requires: [],
      check() {
        throw new Error("the integration is unavailable");
      },
    });

    const [evaluation] = await evaluate(
      registry,
      condition({ predicate: "explodes" }),
    );

    expect(evaluation?.holds).toBe(false);
    expect(evaluation?.detail).toMatch(/the integration is unavailable/);
  });

  it("preserves the declared order, so feedback reads in the order asked", async () => {
    const registry = createConditionChecks(noExec);
    writeFileSync(join(dir, "second.txt"), "yes", "utf8");

    const evaluations = await evaluate(
      registry,
      condition({ id: "first", args: { path: "first.txt" } }),
      condition({ id: "second", args: { path: "second.txt" } }),
    );

    expect(evaluations.map((one) => one.conditionId)).toEqual([
      "first",
      "second",
    ]);
    expect(evaluations.map((one) => one.holds)).toEqual([false, true]);
  });
});
