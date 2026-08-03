/**
 * Worker-thread entry for the plugin host.
 *
 * Runs inside the worker, loads the plugin module named by `workerData`, and
 * speaks the protocol in `protocol.ts`. Every plugin failure is caught and reported
 * as a message — a plugin that throws must degrade to "unavailable, reported",
 * never to a crashed host (§10.2).
 *
 * This file stays **self-contained at runtime** (type-only local imports), because
 * in tests it is executed straight from `src/` by Node's type stripping, where
 * `./protocol.js` does not exist on disk and a `.js` specifier is not resolved to a
 * `.ts` file. The consequence is deliberate: nothing is validated here beyond what
 * is needed to answer, and the manifest is read into a descriptor **by the host**,
 * at the boundary, where conformance and contract-version rules live.
 *
 * The worker is also where "a plugin's only reach is what the host injects" is
 * true in the plainest way: it holds the plugin object and a message port, and it
 * hands the plugin a context of exactly `log` plus per-call credentials. There is
 * no store, no client, and nothing that authors a context edge (principle 1).
 */
import { parentPort, workerData } from "node:worker_threads";

import type { PluginCallContext } from "./contract/contributions.js";
import type {
  HostToWorkerMessage,
  PluginInvocation,
  WireCallContext,
  WorkerBootData,
  WorkerToHostMessage,
} from "./protocol.js";

const port = parentPort;
if (port === null) {
  throw new Error("plugin worker entry must run inside a worker thread");
}

const post = (message: WorkerToHostMessage): void => {
  port.postMessage(message);
};

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Which manifest list and method each invocation kind resolves to. */
const TARGETS: Readonly<
  Record<PluginInvocation["kind"], { key: string; method: string }>
> = {
  "concept.read": { key: "conceptProducers", method: "read" },
  "write.perform": { key: "writeActions", method: "perform" },
  "tool.call": { key: "agentTools", method: "call" },
  "condition.check": { key: "conditionChecks", method: "check" },
  "content.render": { key: "contentRenderers", method: "renderAgentContent" },
  "content.delta": { key: "contentRenderers", method: "renderDelta" },
  "card.render": { key: "cardRenderers", method: "renderCard" },
  "workspace.checkConfig": { key: "workspaceKinds", method: "checkConfig" },
  "workspace.provision": { key: "workspaceKinds", method: "provision" },
  "workspace.runSetup": { key: "workspaceKinds", method: "runSetup" },
  "workspace.status": { key: "workspaceKinds", method: "status" },
  "workspace.fingerprint": { key: "workspaceKinds", method: "fingerprint" },
  "workspace.remove": { key: "workspaceKinds", method: "remove" },
  "palette.invoke": { key: "paletteEntries", method: "invoke" },
};

/**
 * Strip handlers so the declaration can cross the boundary. One level deep is
 * enough and is the point: a contribution's declared fields are data, and the only
 * functions on it are its handlers.
 */
const declarationOf = (
  contribution: Record<string, unknown>,
): Record<string, unknown> => {
  const declaration: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(contribution)) {
    if (typeof value !== "function") {
      declaration[key] = value;
    }
  }
  return declaration;
};

const rawManifest = (manifest: Record<string, unknown>): unknown => {
  const contributions = isRecord(manifest["contributions"])
    ? manifest["contributions"]
    : {};
  const rawContributions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(contributions)) {
    if (!Array.isArray(value)) {
      rawContributions[key] = value;
      continue;
    }
    rawContributions[key] = value.map((entry: unknown) =>
      isRecord(entry) ? declarationOf(entry) : entry,
    );
  }
  return {
    id: manifest["id"],
    name: manifest["name"],
    version: manifest["version"],
    contractVersion: manifest["contractVersion"],
    permissions: manifest["permissions"] ?? [],
    contributions: rawContributions,
  };
};

const main = async (): Promise<void> => {
  const { moduleUrl } = workerData as WorkerBootData;

  let manifest: Record<string, unknown>;
  try {
    const loaded = (await import(moduleUrl)) as { default?: unknown };
    if (!isRecord(loaded.default)) {
      post({
        type: "load-failed",
        reason:
          "module's default export is not a plugin manifest " +
          "(expected an object with id, version, contractVersion and contributions)",
      });
      return;
    }
    manifest = loaded.default;
  } catch (error) {
    post({ type: "load-failed", reason: describe(error) });
    return;
  }

  const contributionsOf = (key: string): readonly unknown[] => {
    const contributions = manifest["contributions"];
    if (!isRecord(contributions)) {
      return [];
    }
    const entries = contributions[key];
    return Array.isArray(entries) ? entries : [];
  };

  const resolve = (
    invocation: PluginInvocation,
  ): { handler: (...args: unknown[]) => unknown; self: object } | string => {
    const target = TARGETS[invocation.kind];
    for (const entry of contributionsOf(target.key)) {
      if (!isRecord(entry)) {
        continue;
      }
      const id = entry["id"] ?? entry["name"];
      if (id !== invocation.contributionId) {
        continue;
      }
      const handler = entry[target.method];
      if (typeof handler !== "function") {
        return `${invocation.contributionId} has no ${target.method} handler`;
      }
      return {
        handler: handler as (...args: unknown[]) => unknown,
        self: entry,
      };
    }
    return `no ${target.key} contribution named ${invocation.contributionId}`;
  };

  const argsFor = (
    invocation: PluginInvocation,
    context: PluginCallContext,
  ): unknown[] => {
    switch (invocation.kind) {
      case "concept.read":
        return [invocation.request, context];
      case "write.perform":
      case "tool.call":
      case "condition.check":
        return [invocation.input, context];
      case "content.render":
        return [invocation.object, context];
      case "content.delta":
        return [invocation.previous, invocation.next, context];
      case "card.render":
        return [invocation.object, invocation.detail, context];
      case "workspace.checkConfig":
        return [invocation.config, context];
      case "workspace.provision":
      case "workspace.runSetup":
        return [invocation.request, context];
      case "workspace.status":
      case "workspace.fingerprint":
        return [invocation.workspace, context];
      case "workspace.remove":
        return [invocation.workspace, invocation.options, context];
      case "palette.invoke":
        return [context];
    }
  };

  const contextFor = (wire: WireCallContext): PluginCallContext => ({
    invocationId: wire.invocationId,
    actor: wire.actor,
    credentials: wire.credentials,
    grants: wire.grants,
    log: (message: string): void => {
      post({ type: "log", invocationId: wire.invocationId, message });
    },
  });

  const handle = async (message: HostToWorkerMessage): Promise<void> => {
    switch (message.type) {
      case "dispose": {
        try {
          const dispose = manifest["dispose"];
          if (typeof dispose === "function") {
            await (dispose as () => unknown).call(manifest);
          }
        } catch {
          // A plugin that throws on the way out has already been let go of.
        } finally {
          process.exit(0);
        }
        break;
      }
      case "invoke": {
        try {
          const resolved = resolve(message.invocation);
          if (typeof resolved === "string") {
            post({ type: "call-failed", id: message.id, reason: resolved });
            return;
          }
          const value: unknown = await resolved.handler.apply(
            resolved.self,
            argsFor(message.invocation, contextFor(message.context)),
          );
          post({ type: "result", id: message.id, value });
        } catch (error) {
          post({
            type: "call-failed",
            id: message.id,
            reason: describe(error),
          });
        }
        break;
      }
    }
  };

  port.on("message", (message: HostToWorkerMessage) => {
    void handle(message);
  });

  post({ type: "loaded", manifest: rawManifest(manifest) });
};

void main();
