/**
 * Host ↔ worker protocol (§10.2).
 *
 * One plugin, one worker thread, one channel. Everything on it is structured-clone
 * data: handlers stay in the worker and are reached by **contribution point plus
 * id**, which is why the descriptor the worker sends at load carries ids and no
 * functions.
 *
 * Two shapes are deliberate:
 *
 * - **An invocation is typed by kind**, and {@link InvocationResults} maps each kind
 *   to what comes back, so `host.invoke` is typed end to end rather than returning
 *   `unknown` for the caller to assert about.
 * - **A throw is a fault, not a result.** A handler that wants to report failure
 *   returns `ok: false`; a handler that throws degrades the plugin to unavailable
 *   (§10.2). The two are different facts and the protocol keeps them different.
 */
import type {
  CardDetail,
  CardView,
  ConditionResult,
  ProducedObject,
  ProvisionOutcome,
  ProvisionRequest,
  ReadRequest,
  ReadResult,
  RemovalOutcome,
  RenderedContent,
  SetupAttemptResult,
  SetupRequest,
  ToolResult,
  WorkspaceConfigCheck,
  WorkspaceFingerprint,
  WorkspaceKindConfig,
  WorkspaceRef,
  WorkspaceStatus,
  WriteResult,
} from "./contract/contributions.js";
import type { ContributionId } from "./contract/ids.js";
import type { PermissionId, PluginActor } from "./contract/permissions.js";

/** Passed to the worker as `workerData`. */
export interface WorkerBootData {
  readonly moduleUrl: string;
}

/**
 * The call context as it crosses the wire: everything in
 * {@link import("./contract/contributions.js").PluginCallContext} except `log`,
 * which is a function the worker supplies over this same channel.
 *
 * `actor` is here rather than in the invocation because it is the host's statement
 * about **who the call acts as** (principle 1). A plugin never sends one.
 */
export interface WireCallContext {
  readonly invocationId: string;
  readonly actor: PluginActor | null;
  readonly credentials: Readonly<Record<string, string>>;
  readonly grants: readonly PermissionId[];
}

/** What the host can ask a loaded plugin to do. */
export type PluginInvocation =
  | {
      readonly kind: "concept.read";
      readonly contributionId: ContributionId;
      readonly request: ReadRequest;
    }
  | {
      readonly kind: "write.perform";
      readonly contributionId: ContributionId;
      readonly input: unknown;
    }
  | {
      readonly kind: "tool.call";
      readonly contributionId: ContributionId;
      readonly input: unknown;
    }
  | {
      readonly kind: "condition.check";
      readonly contributionId: ContributionId;
      readonly input: unknown;
    }
  | {
      readonly kind: "content.render";
      readonly contributionId: ContributionId;
      readonly object: ProducedObject;
    }
  | {
      readonly kind: "content.delta";
      readonly contributionId: ContributionId;
      readonly previous: ProducedObject;
      readonly next: ProducedObject;
    }
  | {
      readonly kind: "card.render";
      readonly contributionId: ContributionId;
      readonly object: ProducedObject;
      readonly detail: CardDetail;
    }
  /* --- workspace kinds: one invocation per method of the kind contract (§3.4) --- */
  | {
      readonly kind: "workspace.checkConfig";
      readonly contributionId: ContributionId;
      readonly config: WorkspaceKindConfig;
    }
  | {
      readonly kind: "workspace.provision";
      readonly contributionId: ContributionId;
      readonly request: ProvisionRequest;
    }
  | {
      readonly kind: "workspace.runSetup";
      readonly contributionId: ContributionId;
      readonly request: SetupRequest;
    }
  | {
      readonly kind: "workspace.status";
      readonly contributionId: ContributionId;
      readonly workspace: WorkspaceRef;
    }
  | {
      readonly kind: "workspace.fingerprint";
      readonly contributionId: ContributionId;
      readonly workspace: WorkspaceRef;
    }
  | {
      readonly kind: "workspace.remove";
      readonly contributionId: ContributionId;
      readonly workspace: WorkspaceRef;
      readonly options: { readonly force: boolean };
    }
  /**
   * A palette entry the operator picked (§11). It answers nothing: a plugin's
   * reach is `log` and its credentials, so an entry cannot ask the host to do
   * anything — see `docs/plugin-contract.md` §6.
   */
  | {
      readonly kind: "palette.invoke";
      readonly contributionId: ContributionId;
    };

/** What each invocation kind answers with. */
export interface InvocationResults {
  "concept.read": ReadResult;
  "write.perform": WriteResult;
  "tool.call": ToolResult;
  "condition.check": ConditionResult;
  "content.render": RenderedContent;
  "content.delta": RenderedContent;
  "card.render": CardView;
  "workspace.checkConfig": WorkspaceConfigCheck;
  "workspace.provision": ProvisionOutcome;
  "workspace.runSetup": SetupAttemptResult;
  "workspace.status": WorkspaceStatus;
  "workspace.fingerprint": WorkspaceFingerprint;
  "workspace.remove": RemovalOutcome;
  "palette.invoke": void;
}

export type InvocationKind = PluginInvocation["kind"];

export type InvocationOf<K extends InvocationKind> = Extract<
  PluginInvocation,
  { readonly kind: K }
>;

export type ResultOf<K extends InvocationKind> = InvocationResults[K];

export type HostToWorkerMessage =
  | {
      readonly type: "invoke";
      readonly id: number;
      readonly invocation: PluginInvocation;
      readonly context: WireCallContext;
    }
  | { readonly type: "dispose" };

export type WorkerToHostMessage =
  | {
      readonly type: "loaded";
      /** The manifest with every function removed; the host reads it into a descriptor. */
      readonly manifest: unknown;
    }
  | { readonly type: "load-failed"; readonly reason: string }
  | {
      readonly type: "result";
      readonly id: number;
      readonly value: unknown;
    }
  | {
      readonly type: "call-failed";
      readonly id: number;
      readonly reason: string;
    }
  | {
      readonly type: "log";
      readonly invocationId: string;
      readonly message: string;
    };
