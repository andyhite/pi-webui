import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Workspace, WorldCondition } from "@plotroom/core";
import { PluginHost } from "@plotroom/plugin-sdk";
import { ConditionCheckRegistry } from "../conditions/registry.js";
import { Logger } from "../logging/logger.js";
import { hostedConditionCheckers } from "./conditions.js";
import { PluginInvoker } from "./invoker.js";

/**
 * A plugin's condition checks, mounted in the server's own registry (§3.5, §4.3).
 *
 * The property Epic 7.3 asked this track for is the one the first test proves: the
 * **workspace path is supplied in the declared input**. A `ConditionCheck` is handed
 * an input and a call context and nothing else — the contract gives it no workspace —
 * so the git plugin's checks declare a `path` field and the server fills it in. The
 * condition below declares no path of its own, so a `met` answer naming the checkout
 * could only have come from here.
 */
const logger = new Logger("error");

const entry = new URL("./test-fixtures/condition-plugin.ts", import.meta.url);

let host: PluginHost;
let registry: ConditionCheckRegistry;

const workspace = { id: "workspace-1" } as unknown as Workspace;

const condition = (
  predicate: string,
  args?: Record<string, string>,
): WorldCondition =>
  ({
    id: `condition-${predicate}`,
    predicate,
    description: predicate,
    ...(args === undefined ? {} : { args }),
  }) as unknown as WorldCondition;

beforeEach(async () => {
  host = await PluginHost.load(entry, {});
  await host.settled();
  registry = new ConditionCheckRegistry();
  const invoker = new PluginInvoker({ logger, host: () => host });
  const descriptor = host.descriptor;
  if (descriptor === null) throw new Error("the fixture plugin did not load");
  for (const checker of hostedConditionCheckers({ descriptor, invoker })) {
    registry.register(checker);
  }
});

afterEach(async () => {
  await host?.dispose();
});

describe("plugin-contributed condition checks", () => {
  it("mounts each check under its contribution id, with the fields it declared required", () => {
    expect([...registry.predicates()].sort()).toEqual([
      "never_sure",
      "path_supplied",
    ]);
  });

  it("supplies the workspace path in the declared input", async () => {
    const [evaluation] = await registry.evaluate([condition("path_supplied")], {
      workspace,
      workspacePath: "/tmp/checkout-42",
    });

    expect(evaluation?.holds).toBe(true);
    expect(evaluation?.detail).toBe("read /tmp/checkout-42");
  });

  it("lets the condition's own argument win where it supplied one", async () => {
    const [evaluation] = await registry.evaluate(
      [condition("path_supplied", { path: "/tmp/declared-instead" })],
      { workspace, workspacePath: "/tmp/checkout-42" },
    );

    expect(evaluation?.detail).toBe("read /tmp/declared-instead");
  });

  it("treats `unknown` as not proven, and says whose evidence it is", async () => {
    const [evaluation] = await registry.evaluate([condition("never_sure")], {
      workspace,
      workspacePath: "/tmp/checkout-42",
    });

    expect(evaluation?.holds).toBe(false);
    expect(evaluation?.detail).toContain("this check never knows");
    expect(evaluation?.detail).toContain("not proof");
  });

  it("stops answering when the plugin is unregistered, rather than passing quietly", async () => {
    registry.unregister("path_supplied");

    const [evaluation] = await registry.evaluate([condition("path_supplied")], {
      workspace,
      workspacePath: "/tmp/checkout-42",
    });

    expect(evaluation?.holds).toBe(false);
    expect(evaluation?.detail).toContain("nobody checked");
  });
});
