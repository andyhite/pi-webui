/**
 * Per-plugin worker host with failure isolation (§10.2).
 *
 * One plugin, one worker thread. A plugin that throws, hangs, fails to load, is
 * built against a contract this host does not implement, or does not conform,
 * degrades to **that plugin being unavailable, with a reported reason** — never a
 * crashed host and never a product that will not start. `PluginHost.load`
 * therefore always resolves: failure is a health state, not an exception. Only
 * calls against a plugin that is not ready reject.
 *
 * Three rules the host enforces that the contract can only declare:
 *
 * - **Permissions gate every invocation.** A contribution's declared permissions
 *   must be granted; an unanswered one produces a §6.6 raise (grants are the
 *   operator's act — see `docs/plugin-contract.md`), an answered denial simply
 *   refuses. Credential values are injected for granted names only and redacted
 *   out of the result (§9.3).
 * - **A tool call names its calling session.** The actor is the host's, supplied
 *   per call, and there is no invocation shape by which a plugin supplies one
 *   (principle 1). Non-tool invocations act as nobody.
 * - **Restarts are bounded** (principle 11). A plugin that loaded and then crashed
 *   is restarted a fixed number of times with backoff and then gives up, saying so.
 *   A plugin that never loaded is **not** retried: retrying a deterministic load
 *   failure is the infinite restart that principle rules out.
 */
import { Worker } from "node:worker_threads";

import type {
  ContributionDescriptor,
  ContributionPoint,
  PluginDescriptor,
} from "./contract/manifest.js";
import { checkConformance, readDescriptor } from "./contract/manifest.js";
import type { ContractVersionRange } from "./contract/versioning.js";
import { checkContractVersion } from "./contract/versioning.js";
import type {
  PermissionGrant,
  PermissionId,
  PermissionRaise,
  PermissionRequest,
  PermissionState,
  PluginActor,
} from "./contract/permissions.js";
import { permissionRaise } from "./contract/permissions.js";
import type { CredentialResolver, InjectedCredential } from "./credentials.js";
import { redactCredentials } from "./credentials.js";
import type {
  HostToWorkerMessage,
  InvocationKind,
  InvocationOf,
  ResultOf,
  WorkerBootData,
  WorkerToHostMessage,
} from "./protocol.js";

export type PluginHealth =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly descriptor: PluginDescriptor;
      /** Out of date is a health state, not a failure (§10.2). */
      readonly warnings: readonly string[];
    }
  | {
      readonly status: "restarting";
      readonly reason: string;
      readonly attempt: number;
    }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "disposed" };

export class PluginUnavailableError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`plugin unavailable: ${reason}`);
    this.name = "PluginUnavailableError";
    this.reason = reason;
  }
}

/**
 * A call the host refused before the plugin saw it: an ungranted permission, an
 * unknown contribution, a tool call with no calling session.
 *
 * `raise` is set when the refusal is an **unanswered** permission — that is the
 * §6.6 approval the operator answers, and the call is blocked meanwhile rather than
 * silently degraded. A permission already denied carries no raise: it was answered,
 * and re-raising it would be asking again with nobody having changed anything.
 */
export class PluginCallRefusedError extends Error {
  readonly reason: string;
  readonly raise: PermissionRaise | null;

  constructor(reason: string, raise: PermissionRaise | null = null) {
    super(`plugin call refused: ${reason}`);
    this.name = "PluginCallRefusedError";
    this.reason = reason;
    this.raise = raise;
  }
}

export interface RestartPolicy {
  /** How many times a plugin that had loaded may be restarted before giving up. */
  readonly maxRestarts: number;
  /** Backoff before each restart; the last value repeats if attempts outrun it. */
  readonly backoffMs: readonly number[];
}

/** Bounded and short: a plugin that crashes twice in a row is broken (principle 11). */
export const DEFAULT_RESTART_POLICY: RestartPolicy = {
  maxRestarts: 2,
  backoffMs: [200, 1_000],
};

export interface PluginHostOptions {
  /** How long the plugin module may take to load. Defaults to 5000ms. */
  readonly loadTimeoutMs?: number;
  /** How long one invocation may take. Defaults to 5000ms. */
  readonly callTimeoutMs?: number;
  /** What the operator has answered, by permission id. Absent is `never-asked`. */
  readonly grants?: readonly PermissionGrant[];
  /** Where credential values come from; absent means the host has none (§9.3). */
  readonly credentials?: CredentialResolver;
  /** Overridable so the version rule is testable across a window v1 has no room for. */
  readonly contractRange?: ContractVersionRange;
  readonly restart?: RestartPolicy;
  readonly onHealth?: (health: PluginHealth) => void;
  /** Plugin log lines (§10.2 health surface); the server routes them to its log. */
  readonly onLog?: (line: {
    readonly invocationId: string;
    readonly message: string;
  }) => void;
}

const DEFAULT_LOAD_TIMEOUT_MS = 5_000;
const DEFAULT_CALL_TIMEOUT_MS = 5_000;

/** Which contribution point an invocation reaches into. */
const POINT_BY_KIND: Readonly<Record<InvocationKind, ContributionPoint>> = {
  "concept.read": "concept-producer",
  "write.perform": "write-action",
  "tool.call": "agent-tool",
  "condition.check": "condition-check",
  "content.render": "content-renderer",
  "content.delta": "content-renderer",
  "card.render": "card-renderer",
  "workspace.checkConfig": "workspace-kind",
  "workspace.provision": "workspace-kind",
  "workspace.runSetup": "workspace-kind",
  "workspace.status": "workspace-kind",
  "workspace.fingerprint": "workspace-kind",
  "workspace.remove": "workspace-kind",
  "palette.invoke": "palette-entry",
};

/** In tests this module runs straight from `src/`, where the worker entry is a
 * `.ts` file Node executes via type stripping; built output points at the compiled
 * `.js` next to it. */
const workerEntryUrl = (): URL =>
  new URL(
    import.meta.url.endsWith(".ts") ? "./worker-entry.ts" : "./worker-entry.js",
    import.meta.url,
  );

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  readonly timer: NodeJS.Timeout;
  readonly injected: readonly InjectedCredential[];
}

export class PluginHost {
  #worker: Worker | null = null;
  #health: PluginHealth = { status: "loading" };
  #descriptor: PluginDescriptor | null = null;
  readonly #pending = new Map<number, PendingCall>();
  readonly #settledWaiters: ((health: PluginHealth) => void)[] = [];
  #nextCallId = 1;
  #restarts = 0;
  readonly #moduleUrl: string;
  readonly #loadTimeoutMs: number;
  readonly #callTimeoutMs: number;
  readonly #restartPolicy: RestartPolicy;
  readonly #options: PluginHostOptions;
  #grants: readonly PermissionGrant[];

  private constructor(moduleUrl: string, options: PluginHostOptions) {
    this.#moduleUrl = moduleUrl;
    this.#options = options;
    this.#loadTimeoutMs = options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
    this.#callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.#restartPolicy = options.restart ?? DEFAULT_RESTART_POLICY;
    this.#grants = options.grants ?? [];
  }

  /** Load a plugin in a fresh worker thread. Always resolves — a plugin that fails
   * to load yields a host whose health is `unavailable` with the reason (§10.2). */
  static async load(
    moduleUrl: string | URL,
    options: PluginHostOptions = {},
  ): Promise<PluginHost> {
    const host = new PluginHost(String(moduleUrl), options);
    await host.#start();
    return host;
  }

  get health(): PluginHealth {
    return this.#health;
  }

  /** The contract declaration, once read. Null while loading and after a failure. */
  get descriptor(): PluginDescriptor | null {
    return this.#descriptor;
  }

  /** Re-answered grants take effect on the next call; nothing is re-run (§10.2). */
  setGrants(grants: readonly PermissionGrant[]): void {
    this.#grants = grants;
  }

  /** Resolves when the plugin is neither loading nor restarting. */
  async settled(): Promise<PluginHealth> {
    if (
      this.#health.status !== "loading" &&
      this.#health.status !== "restarting"
    ) {
      return this.#health;
    }
    return new Promise<PluginHealth>((resolve) => {
      this.#settledWaiters.push(resolve);
    });
  }

  /**
   * Call one contribution. Typed by invocation kind, gated by declared
   * permissions, and answered within the call timeout or not at all.
   */
  async invoke<K extends InvocationKind>(
    invocation: InvocationOf<K>,
    options: { readonly actor?: PluginActor } = {},
  ): Promise<ResultOf<K>> {
    const worker = this.#worker;
    const health = this.#health;
    if (health.status !== "ready" || worker === null) {
      throw new PluginUnavailableError(this.#currentReason());
    }
    const contribution = this.#findContribution(invocation);
    // The actor is the host's statement, per call, and only a tool call has one:
    // a plugin's tool acts as the calling session (principle 1), and everything
    // else acts as nobody rather than as the plugin.
    const actor =
      invocation.kind === "tool.call" ? (options.actor ?? null) : null;
    if (invocation.kind === "tool.call" && actor === null) {
      throw new PluginCallRefusedError(
        `tool ${invocation.contributionId} was called with no calling session; a plugin tool acts as the session that called it (principle 1)`,
      );
    }
    const injected = await this.#authorize(health.descriptor, contribution);

    const id = this.#nextCallId++;
    const invocationId = `${health.descriptor.id}#${id}`;
    const value = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fail(`plugin did not answer within ${this.#callTimeoutMs}ms`);
      }, this.#callTimeoutMs);
      this.#pending.set(id, { resolve, reject, timer, injected });
      worker.postMessage({
        type: "invoke",
        id,
        invocation,
        context: {
          invocationId,
          actor,
          credentials: Object.fromEntries(
            injected.map((credential) => [
              credential.credentialId,
              credential.value,
            ]),
          ),
          grants: this.#grantedIds(),
        },
      } satisfies HostToWorkerMessage);
    });
    return value as ResultOf<K>;
  }

  /** Tear the plugin down: ask it to dispose, then terminate the worker.
   * Idempotent; never throws. */
  async dispose(): Promise<void> {
    const worker = this.#worker;
    const previous = this.#health;
    this.#worker = null;
    this.#setHealth({ status: "disposed" });
    this.#rejectPending("plugin disposed");
    if (worker === null) {
      return;
    }
    if (previous.status === "ready") {
      worker.postMessage({ type: "dispose" } satisfies HostToWorkerMessage);
      const exited = new Promise<void>((resolve) => {
        worker.once("exit", () => resolve());
      });
      const timeout = new Promise<void>((resolve) => {
        setTimeout(resolve, this.#callTimeoutMs).unref();
      });
      await Promise.race([exited, timeout]);
    }
    await worker.terminate().catch(() => undefined);
  }

  /* ------------------------------------------------------------ permissions */

  #grantedIds(): readonly PermissionId[] {
    return this.#grants
      .filter((grant) => grant.state === "granted")
      .map((grant) => grant.permissionId);
  }

  #stateOf(permissionId: PermissionId): PermissionState {
    return (
      this.#grants.find((grant) => grant.permissionId === permissionId)
        ?.state ?? "never-asked"
    );
  }

  /**
   * Refuse an ungranted call and resolve the credentials a granted one gets.
   *
   * The two are one step because they answer the same question — what may this
   * contribution reach — and splitting them is how a call ends up authorized
   * against one list and injected from another.
   */
  async #authorize(
    descriptor: PluginDescriptor,
    contribution: ContributionDescriptor,
  ): Promise<readonly InjectedCredential[]> {
    const injected: InjectedCredential[] = [];
    for (const permissionId of contribution.permissions) {
      const request = descriptor.permissions.find(
        (candidate) => candidate.id === permissionId,
      );
      if (request === undefined) {
        throw new PluginCallRefusedError(
          `${contribution.point} ${contribution.id} needs the undeclared permission ${permissionId}`,
        );
      }
      const state = this.#stateOf(permissionId);
      if (state !== "granted") {
        throw new PluginCallRefusedError(
          `${descriptor.id} has no grant for ${permissionId} (${state})`,
          state === "never-asked"
            ? permissionRaise({
                pluginId: descriptor.id,
                request,
                tool: contribution.id,
              })
            : null,
        );
      }
      const credential = await this.#resolveCredential(request);
      if (credential !== null) {
        injected.push(credential);
      }
    }
    return injected;
  }

  async #resolveCredential(
    request: PermissionRequest,
  ): Promise<InjectedCredential | null> {
    if (request.scope.kind !== "credential") {
      return null;
    }
    const resolver = this.#options.credentials;
    if (resolver === undefined) {
      // A broken or absent connection is an integration health problem, never
      // mysteriously missing data (§9.3): the call is refused, saying so.
      throw new PluginCallRefusedError(
        `no stored credential for ${request.scope.system} (${request.scope.credentialId})`,
      );
    }
    const value = await resolver({
      credentialId: request.scope.credentialId,
      system: request.scope.system,
    });
    if (value === null || value === "") {
      throw new PluginCallRefusedError(
        `no stored credential for ${request.scope.system} (${request.scope.credentialId})`,
      );
    }
    return { credentialId: request.scope.credentialId, value };
  }

  #findContribution(invocation: {
    readonly kind: InvocationKind;
    readonly contributionId: string;
  }): ContributionDescriptor {
    const point = POINT_BY_KIND[invocation.kind];
    const found = this.#descriptor?.contributions.find(
      (candidate) =>
        candidate.point === point && candidate.id === invocation.contributionId,
    );
    if (found === undefined) {
      throw new PluginCallRefusedError(
        `no ${point} contribution named ${invocation.contributionId}`,
      );
    }
    return found;
  }

  /* ------------------------------------------------------------ the worker */

  #start(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        this.#fail(`plugin did not load within ${this.#loadTimeoutMs}ms`);
        settle();
      }, this.#loadTimeoutMs);

      let worker: Worker;
      try {
        worker = new Worker(workerEntryUrl(), {
          workerData: { moduleUrl: this.#moduleUrl } satisfies WorkerBootData,
          // Do not inherit the parent's CLI flags (test runners register loaders
          // the worker must not depend on).
          execArgv: [],
        });
      } catch (error) {
        this.#fail(`plugin worker could not start: ${describeError(error)}`);
        settle();
        return;
      }
      this.#worker = worker;

      worker.on("message", (message: WorkerToHostMessage) => {
        this.#onMessage(message);
        if (message.type === "loaded" || message.type === "load-failed") {
          settle();
        }
      });
      worker.on("error", (error) => {
        this.#crashed(`plugin worker crashed: ${describeError(error)}`);
        settle();
      });
      worker.on("exit", (code) => {
        if (this.#worker === worker) {
          this.#crashed(`plugin worker exited unexpectedly (code ${code})`);
        }
        settle();
      });
    });
  }

  #onMessage(message: WorkerToHostMessage): void {
    switch (message.type) {
      case "loaded": {
        if (this.#health.status !== "loading") {
          return;
        }
        this.#onLoaded(message.manifest);
        break;
      }
      case "load-failed": {
        this.#fail(message.reason);
        break;
      }
      case "result": {
        const call = this.#pending.get(message.id);
        if (call !== undefined) {
          this.#pending.delete(message.id);
          clearTimeout(call.timer);
          // Nothing the host injected leaves the host boundary (§9.3).
          call.resolve(redactCredentials(message.value, call.injected));
        }
        break;
      }
      case "call-failed": {
        // A throw is a fault, not a result: §10.2 makes the plugin unavailable.
        this.#fail(`plugin threw: ${message.reason}`);
        break;
      }
      case "log": {
        this.#options.onLog?.({
          invocationId: message.invocationId,
          message: message.message,
        });
        break;
      }
    }
  }

  /** Read the manifest at the boundary: version rule, then conformance (§10.2). */
  #onLoaded(raw: unknown): void {
    const read = readDescriptor(raw);
    if (!read.ok) {
      this.#fail(`manifest is not readable: ${read.problems.join("; ")}`);
      return;
    }
    const descriptor = read.descriptor;
    const version = checkContractVersion(
      descriptor.contractVersion,
      this.#options.contractRange,
    );
    if (version.verdict === "refuse") {
      this.#fail(version.reason);
      return;
    }
    const conformance = checkConformance(descriptor);
    if (!conformance.conformant) {
      this.#fail(
        `manifest does not conform to contract v${descriptor.contractVersion}: ${conformance.problems.join("; ")}`,
      );
      return;
    }
    this.#descriptor = descriptor;
    this.#restarts = 0;
    this.#setHealth({
      status: "ready",
      descriptor,
      warnings: version.verdict === "warn" ? [version.reason] : [],
    });
  }

  /**
   * A worker that died after it had loaded. Restart, bounded, or give up saying so
   * (principle 11).
   */
  #crashed(reason: string): void {
    if (
      this.#health.status === "unavailable" ||
      this.#health.status === "disposed" ||
      this.#health.status === "restarting"
    ) {
      return;
    }
    const restartable =
      this.#descriptor !== null &&
      this.#restarts < this.#restartPolicy.maxRestarts;
    if (!restartable) {
      this.#fail(
        this.#descriptor === null
          ? reason
          : `${reason}; gave up after ${this.#restarts} restart${this.#restarts === 1 ? "" : "s"}`,
      );
      return;
    }
    const attempt = ++this.#restarts;
    this.#worker = null;
    this.#rejectPending(`${reason}; restarting`);
    this.#setHealth({ status: "restarting", reason, attempt });
    const backoff =
      this.#restartPolicy.backoffMs[
        Math.min(attempt - 1, this.#restartPolicy.backoffMs.length - 1)
      ] ?? 0;
    const timer = setTimeout(() => {
      if (this.#health.status !== "restarting") {
        return;
      }
      this.#setHealth({ status: "loading" });
      void this.#start();
    }, backoff);
    timer.unref();
  }

  /** Degrade to unavailable-with-reason: the §10.2 failure state. */
  #fail(reason: string): void {
    if (
      this.#health.status === "unavailable" ||
      this.#health.status === "disposed"
    ) {
      return;
    }
    this.#setHealth({ status: "unavailable", reason });
    this.#rejectPending(reason);
    const worker = this.#worker;
    this.#worker = null;
    if (worker !== null) {
      void worker.terminate().catch(() => undefined);
    }
  }

  #setHealth(health: PluginHealth): void {
    this.#health = health;
    this.#options.onHealth?.(health);
    if (health.status === "loading" || health.status === "restarting") {
      return;
    }
    for (const waiter of this.#settledWaiters.splice(0)) {
      waiter(health);
    }
  }

  #rejectPending(reason: string): void {
    for (const call of this.#pending.values()) {
      clearTimeout(call.timer);
      call.reject(new PluginUnavailableError(reason));
    }
    this.#pending.clear();
  }

  #currentReason(): string {
    return this.#health.status === "unavailable"
      ? this.#health.reason
      : `plugin is ${this.#health.status}`;
  }
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
